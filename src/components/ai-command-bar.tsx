import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AlertCircle, ArrowUp, FastForward, HelpCircle, Lightbulb, ShieldCheck, TriangleAlert, Zap, Server, Check, ChevronDown, Copy, CornerDownLeft, Eraser, Loader2, MessageSquareText, MoreHorizontal, Pencil, Play, Radar, RefreshCw, RotateCcw, Sparkles, Square, SquareTerminal, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AI_SETTINGS_EVENT, streamAICommand, loadAISettings, saveAISettings, isAIConfigured, createAbortController, type AISettings } from '@/lib/ai'
import {
  AI_RUN_MODES, MAX_AUTO_STEPS, autoRunAllowed, buildHistory, currentModelTarget, extractSuggestion, isNoteReply, loadRunMode, nextStepTip, loadConversation, noteText, outputLooksFailed, parseQuestion, saveConversation, saveRunMode, splitReply, trimCapturedOutput,
  type AIRunMode, type AITurn, type RunOutcome, type TerminalAiBridge, type TerminalCapture,
} from '@/lib/ai-conversation'
import { aiAssistantCopy, fillCopy } from '@/lib/locales/ai-assistant'
import { hostFactsText, type HostFact } from '@/lib/ai-host-facts'
import { suggestPrompts } from '@/lib/ai-suggestions'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'
import { AiAssistantSheet, type AiSheetMessage } from './mobile/ai-assistant-sheet'
import { CommandRiskChip } from './mobile/command-risk-chip'
import { useNarrowViewport } from './mobile/use-narrow-viewport'
import { AIModelSwitcher } from './ai-model-switcher'

interface AICommandBarProps {
  /** Fallback when no bridge is available: sends raw input to the session. */
  onExecuteCommand: (command: string) => void
  getTerminalContext: () => string
  /** Runs commands in the terminal and reads back their output for the next message. */
  bridge?: TerminalAiBridge
  visible: boolean
  onClose: () => void
  /** `auto` shows a bottom sheet below the md breakpoint. */
  presentation?: 'auto' | 'inline' | 'sheet'
  contextLabel?: string
  /** Vault and host the conversation is remembered under; without it nothing is kept. */
  memoryKey?: string
  /** What ShellBeam knows about the server, sent so commands fit the machine. */
  hostFacts?: HostFact[]
  /** The host's last asset scan, used to suggest requests that fit this server. */
  inventory?: WorkspaceInventory
  /** Present while the host can still get a ShellBeam probe. */
  probe?: { onInstall: () => void }
}

const PROBE_TIP_KEY = 'shellbeam.aiProbeTipDismissed.'
const readFlag = (key: string) => { try { return localStorage.getItem(key) === '1' } catch { return false } }
const writeFlag = (key: string) => { try { localStorage.setItem(key, '1') } catch { /* private mode */ } }

const CONTEXT_LINES = 30
/** Output counts as finished once the terminal has been quiet this long. */
const SETTLE_MS = 1200
/** Without a known prompt there is no way to tell a slow command from a stuck one. */
const CAPTURE_LIMIT_MS = 20_000
/** With a known prompt, long installs and builds are waited for. */
const PROMPT_LIMIT_MS = 10 * 60_000
const PROMPT_IDLE_MS = 200
const INPUT_IDLE_MS = 1500
const POLL_MS = 250
const LIVE_MS = 400
type AutoStatusKind = 'running' | 'waiting' | 'limit' | 'unsettled' | 'input'
type RunOptions = { source?: string; auto?: boolean }
let turnSeq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++turnSeq}`

export function AICommandBar({ onExecuteCommand, getTerminalContext, bridge, visible, onClose, presentation = 'auto', contextLabel, memoryKey, hostFacts, inventory, probe }: AICommandBarProps) {
  const { t, locale } = useT()
  const copy = aiAssistantCopy[locale]
  const narrow = useNarrowViewport()
  const asSheet = presentation === 'sheet' || (presentation === 'auto' && narrow)
  const [settings, setSettings] = useState<AISettings>(loadAISettings)
  const [restored] = useState(() => (memoryKey ? loadConversation(memoryKey) : null))
  const [restoredAt, setRestoredAt] = useState(restored?.savedAt ?? null)
  const [turns, setTurns] = useState<AITurn[]>(() => restored?.turns ?? [])
  const [input, setInput] = useState('')
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [includeContext, setIncludeContext] = useState(true)
  const [includeFacts, setIncludeFacts] = useState(true)
  const factsText = useMemo(() => hostFactsText(hostFacts ?? []), [hostFacts])
  const [reportedModel, setReportedModel] = useState('')
  const suggestions = useMemo(() => suggestPrompts(inventory, copy.smart, copy.examples), [inventory, copy])
  const probeTipKey = `${PROBE_TIP_KEY}${memoryKey ?? ''}`
  const [probeTipDismissed, setProbeTipDismissed] = useState(() => readFlag(probeTipKey))
  const dismissProbeTip = () => { writeFlag(probeTipKey); setProbeTipDismissed(true) }
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const runModeKey = memoryKey ?? ''
  const [runMode, setRunMode] = useState<AIRunMode>(() => loadRunMode(runModeKey))
  const runModeRef = useRef(runMode)
  useEffect(() => { runModeRef.current = runMode }, [runMode])
  const [confirmAuto, setConfirmAuto] = useState(false)
  /** The automatic run of the current request; null when every step waits for a click. */
  const chainRef = useRef<{ steps: number } | null>(null)
  const [autoState, setAutoState] = useState<{ status: AutoStatusKind; steps: number } | null>(null)
  const continueAfterRef = useRef<string | null>(null)
  const runRef = useRef<(command: string, options?: RunOptions) => void>(() => {})
  const stopChain = useCallback((status?: 'unsettled' | 'input') => {
    chainRef.current = null
    continueAfterRef.current = null
    setAutoState(status ? { status, steps: 0 } : null)
  }, [])
  /** Runs an automatic step when the mode allows it, otherwise leaves the chain waiting for a click. */
  const advanceChain = useCallback((reply: string, source: string) => {
    const chain = chainRef.current
    if (!chain) return
    const question = parseQuestion(reply)
    if (question || isNoteReply(reply)) { stopChain(); return }
    const { command } = splitReply(reply)
    if (!command) { stopChain(); return }
    if (!autoRunAllowed(runModeRef.current, command)) { setAutoState({ status: 'waiting', steps: chain.steps }); return }
    if (chain.steps >= MAX_AUTO_STEPS) { setAutoState({ status: 'limit', steps: chain.steps }); return }
    chain.steps += 1
    setAutoState({ status: 'running', steps: chain.steps })
    runRef.current(command, { source, auto: true })
  }, [stopChain])
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sheetInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamBuf = useRef('')
  const captures = useRef(new Map<string, { capture: TerminalCapture; stop: () => void; finish?: () => void }>())
  const turnsRef = useRef(turns)
  useEffect(() => { turnsRef.current = turns }, [turns])
  useEffect(() => { if (memoryKey) saveConversation(memoryKey, turns) }, [memoryKey, turns])

  useEffect(() => {
    const sync = () => setSettings(loadAISettings())
    window.addEventListener(AI_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(AI_SETTINGS_EVENT, sync)
  }, [])

  const stopCaptures = useCallback(() => {
    for (const entry of captures.current.values()) { entry.stop(); entry.capture.dispose() }
    captures.current.clear()
  }, [])

  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => (asSheet ? sheetInputRef : inputRef).current?.focus(), 100)
      return () => clearTimeout(timer)
    }
    abortRef.current?.abort()
    abortRef.current = null
    chainRef.current = null
    continueAfterRef.current = null
    // Hiding the panel ends any automatic run; drop its status so it is not stale when reopened.
    const timer = setTimeout(() => setAutoState(null), 0)
    return () => clearTimeout(timer)
  }, [visible, asSheet])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, streamingContent, isStreaming])

  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; stopCaptures() }, [stopCaptures])

  const changeSettings = useCallback((next: AISettings) => {
    setSettings(next)
    setReportedModel('')
    saveAISettings(next)
  }, [])

  const submit = useCallback(async (text: string, options: { auto?: boolean } = {}) => {
    const prompt = text.trim()
    if (!prompt || abortRef.current) return
    const current = loadAISettings()
    if (!isAIConfigured(current)) {
      setTurns((prev) => [...prev, { id: nextId('e'), kind: 'error', text: t('ai.notConfigured') }])
      return
    }
    const history = buildHistory(turnsRef.current)
    if (!options.auto) {
      chainRef.current = runModeRef.current === 'confirm' ? null : { steps: 0 }
      continueAfterRef.current = null
      setAutoState(chainRef.current ? { status: 'running', steps: 0 } : null)
    }
    setTurns((prev) => [...prev, { id: nextId('u'), kind: 'user', text: prompt, ...(options.auto ? { auto: true } : {}) }])
    setInput('')
    setIsStreaming(true)
    setStreamingContent('')
    streamBuf.current = ''
    const started = Date.now()
    const target = currentModelTarget(current)
    let served = ''

    const ac = createAbortController()
    abortRef.current = ac
    ac.signal.addEventListener('abort', () => {
      if (abortRef.current !== ac) return
      setStreamingContent(''); setIsStreaming(false)
    }, { once: true })
    const context = includeContext ? (bridge?.recentOutput(CONTEXT_LINES) ?? getTerminalContext()) : ''
    const live = () => !ac.signal.aborted && abortRef.current === ac

    await streamAICommand(current, prompt, context, {
      onToken(token) {
        if (!live()) return
        streamBuf.current += token
        setStreamingContent(streamBuf.current)
      },
      onModel(model) {
        if (!live()) return
        served = model
        setReportedModel(model)
      },
      onDone() {
        if (!live()) return
        const { body: content, suggestion } = extractSuggestion(streamBuf.current)
        const replyId = nextId('a')
        if (content) {
          const model = served || target.model || target.providerName
          setTurns((prev) => [...prev, { id: replyId, kind: 'ai', text: content, model, durationMs: Date.now() - started, ...(suggestion ? { suggestion } : {}) }])
        }
        setStreamingContent('')
        setIsStreaming(false)
        abortRef.current = null
        if (content) advanceChain(content, replyId)
        else stopChain()
        setTimeout(() => inputRef.current?.focus(), 50)
      },
      onError(message) {
        if (!live()) return
        setTurns((prev) => [...prev, { id: nextId('e'), kind: 'error', text: message }])
        setStreamingContent('')
        setIsStreaming(false)
        abortRef.current = null
        stopChain()
      },
    }, ac.signal, history, includeFacts ? factsText : '', runModeRef.current)
  }, [includeContext, includeFacts, bridge, getTerminalContext, factsText, t, advanceChain, stopChain])

  const handleCancel = useCallback(() => {
    stopChain()
    abortRef.current?.abort()
    abortRef.current = null
    streamBuf.current = ''
    setStreamingContent('')
    setIsStreaming(false)
  }, [stopChain])

  const updateRun = useCallback((id: string, patch: Partial<Extract<AITurn, { kind: 'run' }>>) => {
    setTurns((prev) => prev.map((turn) => (turn.id === id && turn.kind === 'run' ? { ...turn, ...patch } : turn)))
  }, [])

  const readCapture = useCallback((id: string) => {
    const entry = captures.current.get(id)
    if (!entry) return
    const { text, lineCount } = trimCapturedOutput(entry.capture.read())
    updateRun(id, { output: text, lineCount })
  }, [updateRun])

  const handleRun = useCallback((command: string, options: RunOptions = {}) => {
    const id = nextId('r')
    const startedAt = Date.now()
    const base = { id, kind: 'run' as const, command, output: '', lineCount: 0, startedAt, ...(options.source ? { source: options.source } : {}), ...(options.auto ? { auto: true } : {}) }
    // A click during an automatic run is the user taking part, so the step budget starts over.
    if (!options.auto && chainRef.current) chainRef.current.steps = 0
    if (!bridge) {
      onExecuteCommand(command + '\n')
      setTurns((prev) => [...prev, { ...base, state: 'sent' }])
      return
    }
    const capture = bridge.run(command)
    setTurns((prev) => [...prev, { ...base, state: 'running' }])
    const promptKnown = capture.status?.() === 'busy'
    const limitMs = promptKnown ? PROMPT_LIMIT_MS : CAPTURE_LIMIT_MS
    let lastOutput = Date.now()
    let live: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = capture.onOutput(() => {
      lastOutput = Date.now()
      live ??= setTimeout(() => { live = undefined; readCapture(id) }, LIVE_MS)
    })
    // Stops watching, but keeps the capture so "Capture again" can re-read later output.
    const stop = () => { clearInterval(poll); clearTimeout(live); unsubscribe() }
    const finish = (how: 'done' | 'input' | 'timeout' | 'stopped') => {
      stop()
      const { text, lineCount } = trimCapturedOutput(capture.read())
      const outcome: RunOutcome = how === 'done' ? (outputLooksFailed(text) ? 'failed' : 'ok') : how
      updateRun(id, { state: 'captured', output: text, lineCount, outcome, durationMs: Date.now() - startedAt })
      if (!chainRef.current) return
      // Never type the next command into something that is still running or asking a question.
      if (how === 'done') { continueAfterRef.current = id; setAutoState({ status: 'running', steps: chainRef.current.steps }) }
      else if (how === 'input') stopChain('input')
      else if (how === 'timeout') stopChain('unsettled')
      else stopChain()
    }
    const poll = setInterval(() => {
      const idle = Date.now() - lastOutput
      const status = capture.status?.() ?? 'unknown'
      if (status === 'prompt' && idle >= PROMPT_IDLE_MS) finish('done')
      else if (status === 'input' && idle >= INPUT_IDLE_MS) finish('input')
      else if (status === 'unknown' && idle >= SETTLE_MS) finish('done')
      else if (Date.now() - startedAt >= limitMs) finish('timeout')
    }, POLL_MS)
    captures.current.set(id, { capture, stop, finish: () => finish('stopped') })
  }, [bridge, onExecuteCommand, readCapture, stopChain, updateRun])
  useEffect(() => { runRef.current = handleRun }, [handleRun])

  // Sends the captured output back once it is in the conversation, so the next request carries it.
  useEffect(() => {
    const id = continueAfterRef.current
    if (!id || !chainRef.current) return
    const run = turns.find((turn) => turn.id === id)
    if (run?.kind !== 'run' || run.state !== 'captured') return
    const timer = setTimeout(() => {
      if (continueAfterRef.current !== id) return
      continueAfterRef.current = null
      void submit(copy.continuePrompt, { auto: true })
    }, 0)
    return () => clearTimeout(timer)
  }, [turns, submit, copy])

  const changeRunMode = useCallback((mode: AIRunMode) => {
    if (mode === 'auto' && runModeRef.current !== 'auto') { setConfirmAuto(true); return }
    setRunMode(mode)
    saveRunMode(runModeKey, mode)
    if (mode === 'confirm') stopChain()
  }, [runModeKey, stopChain])
  const enableAuto = useCallback(() => {
    setConfirmAuto(false)
    setRunMode('auto')
    saveRunMode(runModeKey, 'auto')
  }, [runModeKey])
  const keepGoing = useCallback(() => {
    const chain = chainRef.current
    const last = [...turnsRef.current].reverse().find((turn) => turn.kind === 'ai')
    if (!chain || last?.kind !== 'ai') return
    chain.steps = 0
    advanceChain(last.text, last.id)
  }, [advanceChain])

  const handleInsert = useCallback((command: string) => {
    if (bridge) bridge.insert(command)
    else onExecuteCommand(command)
  }, [bridge, onExecuteCommand])

  const handleCopy = useCallback(async (id: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch { /* clipboard not available */ }
  }, [])

  const handleNewChat = useCallback(() => {
    handleCancel()
    stopCaptures()
    setTurns([])
    setRestoredAt(null)
    setInput('')
    setReportedModel('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [handleCancel, stopCaptures])

  const tip = useMemo(() => (isStreaming ? '' : nextStepTip(turns, { next: copy.nextPrompt, fix: copy.fixPrompt })), [turns, isStreaming, copy])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Tab' && !event.shiftKey && !input && tip) { event.preventDefault(); setInput(tip); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const latest = [...turnsRef.current].reverse().find((turn): turn is Extract<AITurn, { kind: 'ai' }> => turn.kind === 'ai')
      const command = latest && !isNoteReply(latest.text) ? splitReply(latest.text).command : ''
      if (command && !turnsRef.current.some((turn) => turn.kind === 'run' && turn.source === latest!.id && turn.state === 'running')) handleRun(command, { source: latest!.id })
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(input) }
    if (event.key === 'Escape') { if (isStreaming) handleCancel(); else onClose() }
  }, [submit, input, tip, handleCancel, isStreaming, onClose, handleRun])

  if (!visible) return null

  const lastTurn = turns[turns.length - 1]
  const lastPrompt = [...turns].reverse().find((turn): turn is Extract<AITurn, { kind: 'user' }> => turn.kind === 'user' && !turn.auto)?.text ?? ''
  const lastRunBySource = new Map<string, Extract<AITurn, { kind: 'run' }>>()
  for (const turn of turns) if (turn.kind === 'run' && turn.source) lastRunBySource.set(turn.source, turn)
  const followUps = !isStreaming && lastTurn?.kind === 'run' && lastTurn.state === 'captured'
    ? [
        ...(outputLooksFailed(lastTurn.output) ? [{ label: copy.fix, prompt: copy.fixPrompt }] : []),
        { label: copy.explain, prompt: copy.explainPrompt },
        { label: copy.next, prompt: copy.nextPrompt },
      ]
    : []

  if (asSheet) {
    const messages: AiSheetMessage[] = turns.flatMap((turn): AiSheetMessage[] => {
      if (turn.kind === 'user') return [{ id: turn.id, role: 'user', content: turn.text }]
      if (turn.kind === 'ai') return [{ id: turn.id, role: 'ai', content: turn.text }]
      if (turn.kind === 'run') return [{ id: turn.id, role: 'status', content: turn.command }]
      return []
    })
    const lastError = lastTurn?.kind === 'error' ? lastTurn.text : null
    return (
      <AiAssistantSheet
        contextLabel={contextLabel}
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        error={lastError}
        copiedId={copiedId}
        input={input}
        onInputChange={setInput}
        onInputKeyDown={handleKeyDown}
        onSubmit={() => void submit(input)}
        onCancel={handleCancel}
        onRun={(msg, command) => handleRun(command, { source: msg.id })}
        onCopy={(msg, command) => void handleCopy(msg.id, command)}
        onNewChat={handleNewChat}
        onClose={onClose}
        inputRef={sheetInputRef}
        scrollRef={scrollRef}
      />
    )
  }

  const history = buildHistory(turns)
  const sharedOutputs = history.filter((item) => item.role === 'output').length

  return (
    <aside data-testid="ai-assistant-panel" aria-label={copy.title}
      className="flex h-full w-[400px] min-w-[300px] max-w-[45%] shrink-0 flex-col border-l border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-[var(--workspace-text)]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3">
        <Sparkles className={cn('h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]', isStreaming && 'animate-pulse')} aria-hidden="true" />
        <h2 className="shrink-0 text-[13px] font-semibold text-[var(--workspace-text-strong)]">{copy.title}</h2>
        <span className="flex-1" />
        <AIModelSwitcher settings={settings} reportedModel={reportedModel} onChange={changeSettings} />
        <AIPanelMenu items={[
          { key: 'chat', label: copy.clearChat, icon: RotateCcw, disabled: turns.length === 0 && !isStreaming, onSelect: handleNewChat },
          ...(bridge?.clear ? [{ key: 'screen', label: copy.clearScreen, icon: Eraser, onSelect: bridge.clear }] : []),
          ...(probe ? [{ key: 'probe', label: copy.probeInstall, icon: Radar, onSelect: probe.onInstall }] : []),
        ]} />
        <button type="button" onClick={() => { handleCancel(); onClose() }} title={copy.close} aria-label={copy.close}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && !isStreaming && (
          <div className="space-y-3 px-1 pt-2">
            <p className="text-[13px] font-medium leading-relaxed text-[var(--workspace-text-strong)]">{copy.emptyTitle}</p>
            <p className="text-xs leading-relaxed text-[var(--workspace-text-muted)]">{copy.emptyBody}</p>
            {hostFacts && hostFacts.length > 0 && (
              <div data-testid="ai-host-facts" className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--workspace-text-strong)]"><Server className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" aria-hidden="true" />{copy.knownTitle}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
                  {hostFacts.map((fact) => (
                    <div key={fact.key} className="contents">
                      <dt className="text-[var(--workspace-text-subtle)]">{copy.facts[fact.key]}</dt>
                      <dd className="min-w-0 truncate font-mono text-[11px] text-[var(--workspace-text)]" title={fact.value}>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
                {!hostFacts.some((fact) => fact.key === 'os') && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{copy.knownHint}</p>}
              </div>
            )}
            {probe && !probeTipDismissed && (
              <div data-testid="ai-probe-offer" className="rounded-lg border border-dashed border-primary/50 bg-primary/5 px-3 py-2.5">
                <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--workspace-text-strong)]"><Radar className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" aria-hidden="true" />{copy.probeTitle}</p>
                <p className="text-[11px] leading-relaxed text-[var(--workspace-text-muted)]">{copy.probeBody}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={probe.onInstall}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90">{copy.probeAction}</button>
                  <button type="button" onClick={dismissProbeTip}
                    className="inline-flex h-7 items-center rounded-md px-2 text-[11.5px] text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">{copy.probeDismiss}</button>
                </div>
              </div>
            )}
            {[true, false].map((smart) => {
              const group = suggestions.filter((item) => item.smart === smart)
              if (group.length === 0) return null
              return (
                <div key={String(smart)} data-testid={smart ? 'ai-smart-suggestions' : 'ai-examples'} className="flex flex-col gap-1.5 pt-1">
                  <p className="px-0.5 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{smart ? copy.suggestedFor : copy.examplesTitle}</p>
                  {group.map(({ text }) => {
                    const Icon = smart ? Sparkles : MessageSquareText
                    return (
                      <button key={text} type="button" onClick={() => void submit(text)}
                        className="flex items-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 text-left text-xs text-[var(--workspace-text)] transition-colors hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]">
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', smart ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-subtle)]')} aria-hidden="true" />
                        <span className="min-w-0">{text}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}

        {restoredAt && turns.length > 0 && (
          <p className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-subtle)]">
            <span className="h-px flex-1 bg-[var(--workspace-border-soft)]" />
            {fillCopy(copy.restored, { time: new Date(restoredAt).toLocaleString(locale) })}
            <span className="h-px flex-1 bg-[var(--workspace-border-soft)]" />
          </p>
        )}
        {turns.map((turn) => {
          if (turn.kind === 'user' && turn.auto) return (
            <p key={turn.id} data-testid="ai-auto-continue" className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-subtle)]">
              <span className="h-px flex-1 bg-[var(--workspace-border-soft)]" />
              <FastForward className="h-3 w-3" aria-hidden="true" />{copy.autoContinued}
              <span className="h-px flex-1 bg-[var(--workspace-border-soft)]" />
            </p>
          )
          if (turn.kind === 'user') return (
            <div key={turn.id} className="flex justify-end">
              <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-[var(--workspace-accent-subtle)] px-3 py-2 text-[13px] text-[var(--workspace-text-strong)]">{turn.text}</p>
            </div>
          )
          if (turn.kind === 'error') return (
            <div key={turn.id} role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[var(--workspace-status-bad-text)]">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{turn.text}</span>
              {lastPrompt && turn.id === lastTurn?.id && !isStreaming && (
                <button type="button" onClick={() => void submit(lastPrompt)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-current px-2 text-[11px] font-medium hover:opacity-80">
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />{copy.retry}
                </button>
              )}
            </div>
          )
          if (turn.kind === 'run') return (
            <RunBlock key={turn.id} turn={turn} onRefresh={() => readCapture(turn.id)}
              onInterrupt={bridge?.interrupt} onStopWaiting={() => captures.current.get(turn.id)?.finish?.()} />
          )
          return (
            <CommandCard key={turn.id} turn={turn} copied={copiedId === turn.id} run={lastRunBySource.get(turn.id)}
              onRun={(command) => handleRun(command, { source: turn.id })} onInsert={handleInsert} onCopy={(command) => void handleCopy(turn.id, command)} onAnswer={(text) => void submit(text)} />
          )
        })}

        {isStreaming && (
          <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]">
            {streamingContent
              ? <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--workspace-text-strong)]">{streamingContent.replace(/\n#>[^\n]*$/, '')}<span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-[var(--workspace-accent-text)] align-middle" /></pre>
              : <p className="flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--workspace-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{copy.thinking}</p>}
          </div>
        )}

        {followUps.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {followUps.map((chip) => (
              <button key={chip.label} type="button" onClick={() => void submit(chip.prompt)}
                className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11.5px] text-[var(--workspace-accent-text)] transition-colors hover:border-[color:var(--workspace-primary-500)] hover:bg-[var(--workspace-accent-subtle)]">
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative shrink-0 border-t border-[color:var(--workspace-border-soft)] p-2.5">
        {autoState && (autoState.status !== 'running' || runMode !== 'confirm') && (
          <AutoStatus state={autoState} onStop={handleCancel} onKeepGoing={keepGoing} onDismiss={() => stopChain()} />
        )}
        {confirmAuto && <AutoWarning onConfirm={enableAuto} onCancel={() => setConfirmAuto(false)} />}
        <div className="relative rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] focus-within:border-[color:var(--workspace-primary-500)]">
          {tip && !input && (
            <div data-testid="ai-next-tip" aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-2 flex items-start gap-1.5 text-[13px] text-[var(--workspace-text-muted)]">
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
              <span className="min-w-0 flex-1 line-clamp-2">{tip}</span>
              <kbd className="shrink-0 rounded border border-[color:var(--workspace-border-soft)] px-1 font-sans text-[10px] text-[var(--workspace-text-subtle)]">{copy.tipUse}</kbd>
            </div>
          )}
          <textarea ref={inputRef} value={input} rows={2} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown}
            placeholder={tip ? '' : turns.length ? copy.followUp : copy.placeholder} aria-label={copy.placeholder}
            aria-description={tip ? fillCopy(copy.tipA11y, { tip }) : undefined}
            className="block max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3 pt-2 text-[13px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <RunModePicker mode={runMode} onChange={changeRunMode} />
            <ContextChip icon={SquareTerminal} label={copy.terminalContext} on={includeContext} onToggle={() => setIncludeContext((value) => !value)}
              hint={includeContext ? copy.terminalContextOn : copy.terminalContextOff}
              preview={() => (bridge?.recentOutput(CONTEXT_LINES) ?? getTerminalContext()).trim()} />
            {factsText && (
              <ContextChip icon={Server} label={copy.hostFacts} on={includeFacts} onToggle={() => setIncludeFacts((value) => !value)}
                hint={includeFacts ? copy.hostFactsOn : copy.hostFactsOff} preview={() => factsText} />
            )}
            {history.length > 0 && (
              <span className="min-w-0 truncate text-[11px] text-[var(--workspace-text-subtle)]">
                {fillCopy(copy.shared, { messages: history.length, outputs: sharedOutputs })}
              </span>
            )}
            <span className="flex-1" />
            {isStreaming ? (
              <button type="button" onClick={handleCancel} aria-label={copy.stop} title={copy.stop}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)]">
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button type="button" onClick={() => void submit(input)} aria-label={copy.send} title={copy.send} disabled={!input.trim()}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--workspace-primary-500)] text-white transition-opacity disabled:opacity-30">
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[10.5px] text-[var(--workspace-text-subtle)]">{copy.hint}</p>
      </div>
    </aside>
  )
}

function CommandCard({ turn, copied, run, onRun, onInsert, onCopy, onAnswer }: {
  turn: Extract<AITurn, { kind: 'ai' }>
  copied: boolean
  /** The latest run of this command, by the user or by AI. */
  run?: Extract<AITurn, { kind: 'run' }>
  onRun: (command: string) => void
  onInsert: (command: string) => void
  onCopy: (command: string) => void
  onAnswer: (text: string) => void
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [editing, setEditing] = useState(false)
  const reply = splitReply(turn.text)
  const [draft, setDraft] = useState(reply.command)
  const meta = [turn.model, turn.durationMs ? fillCopy(copy.duration, { seconds: (turn.durationMs / 1000).toFixed(1) }) : ''].filter(Boolean).join(' · ')

  const question = isNoteReply(turn.text) ? parseQuestion(turn.text) : null
  if (question) return (
    <div data-testid="ai-question" className="rounded-lg border border-[color:var(--workspace-primary-500)] bg-[var(--workspace-surface-900)] px-3 py-2.5">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--workspace-accent-text)]"><HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />{copy.question}</p>
      {question.notes && <p className="mb-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--workspace-text-muted)]">{question.notes}</p>}
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--workspace-text-strong)]">{question.question}</p>
      {question.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <button key={option} type="button" onClick={() => onAnswer(option)}
              className="rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2.5 py-1 text-left text-xs text-[var(--workspace-text-strong)] transition-colors hover:border-[color:var(--workspace-primary-500)] hover:bg-[var(--workspace-accent-subtle)]">
              {option}
            </button>
          ))}
        </div>
      )}
      {meta && <p className="mt-1.5 font-mono text-[10.5px] text-[var(--workspace-text-subtle)]">{meta}</p>}
    </div>
  )

  if (isNoteReply(turn.text)) return (
    <div data-testid="ai-note" className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2.5">
      <p className="mb-1 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{copy.answer}</p>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--workspace-text-strong)]">{noteText(turn.text)}</p>
      {meta && <p className="mt-1.5 font-mono text-[10.5px] text-[var(--workspace-text-subtle)]">{meta}</p>}
    </div>
  )

  const command = draft.trim()
  const button = 'flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors'
  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]">
      {reply.caption && <p data-testid="ai-caption" className="whitespace-pre-wrap break-words border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--workspace-text)]">{reply.caption}</p>}
      {editing
        ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(8, draft.split('\n').length + 1)} spellCheck={false} aria-label={copy.edit}
            className="block w-full resize-y bg-[var(--workspace-surface-950)] px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--workspace-text-strong)] outline-none" />
        : <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-[var(--workspace-text-strong)]">{command}</pre>}
      <div className="flex flex-wrap items-center gap-1 border-t border-[color:var(--workspace-border-soft)] px-2 py-1.5">
        {run?.state === 'running' ? (
          <span data-testid="ai-card-run" data-state="running" className={cn(button, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />{copy.runStatus.running}
          </span>
        ) : (
          <button type="button" disabled={!command} onClick={() => { setEditing(false); onRun(command) }} title={copy.runHint}
            className={cn(button, run ? 'border border-[color:var(--workspace-border-soft)] text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]' : 'bg-[var(--workspace-primary-500)] text-white hover:opacity-90', 'disabled:opacity-40')}>
            {run ? <RotateCcw className="h-3 w-3" aria-hidden="true" /> : <Play className="h-3 w-3" aria-hidden="true" />}{run ? copy.runAgain : copy.run}
          </button>
        )}
        <button type="button" disabled={!command} onClick={() => onInsert(command)} title={copy.insertHint}
          className={cn(button, 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]')}>
          <CornerDownLeft className="h-3 w-3" aria-hidden="true" />{copy.insert}
        </button>
        <button type="button" onClick={() => onCopy(command)} className={cn(button, 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]')}>
          {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}{copied ? copy.copied : copy.copy}
        </button>
        <button type="button" onClick={() => setEditing((value) => !value)} aria-pressed={editing} className={cn(button, 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]')}>
          <Pencil className="h-3 w-3" aria-hidden="true" />{editing ? copy.done : copy.edit}
        </button>
        <span className="flex-1" />
        <CommandRiskChip command={command} compact />
      </div>
      {run && run.state !== 'running' && (
        <div data-testid="ai-card-run" data-state={run.outcome ?? run.state} className="flex items-center gap-1.5 border-t border-[color:var(--workspace-border-soft)] px-3 py-1 text-[10.5px] text-[var(--workspace-text-subtle)]">
          {run.outcome && <RunOutcomeChip outcome={run.outcome} />}
          <span>{run.auto ? copy.byAI : copy.byYou}</span>
          {run.durationMs !== undefined && <span>· {fillCopy(copy.duration, { seconds: (run.durationMs / 1000).toFixed(1) })}</span>}
        </div>
      )}
      {meta && <p className="border-t border-[color:var(--workspace-border-soft)] px-3 py-1 font-mono text-[10.5px] text-[var(--workspace-text-subtle)]">{meta}</p>}
    </div>
  )
}

const OUTCOME_TONE: Record<RunOutcome, string> = {
  ok: 'text-[var(--workspace-status-good-text)] bg-[var(--workspace-status-good-bg)]',
  failed: 'text-[var(--workspace-status-bad-text)] bg-[var(--workspace-status-bad-bg)]',
  input: 'text-[var(--workspace-status-warn-text)] bg-[var(--workspace-status-warn-bg)]',
  timeout: 'text-[var(--workspace-status-warn-text)] bg-[var(--workspace-status-warn-bg)]',
  stopped: 'text-[var(--workspace-text-muted)] bg-[var(--workspace-surface-800)]',
}
const OUTCOME_ICON = { ok: Check, failed: X, input: HelpCircle, timeout: TriangleAlert, stopped: Square } as const

function RunOutcomeChip({ outcome }: { outcome: RunOutcome }) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const Icon = OUTCOME_ICON[outcome]
  return (
    <span data-testid="ai-run-outcome" data-outcome={outcome} className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium', OUTCOME_TONE[outcome])}>
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />{copy.runStatus[outcome]}
    </span>
  )
}

function RunBlock({ turn, onRefresh, onInterrupt, onStopWaiting }: {
  turn: Extract<AITurn, { kind: 'run' }>
  onRefresh: () => void
  onInterrupt?: () => void
  onStopWaiting: () => void
}) {
  const { t, locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [expanded, setExpanded] = useState(false)
  const running = turn.state === 'running'
  const small = 'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]'
  return (
    <div data-testid="ai-run" data-state={turn.state} data-outcome={turn.outcome}
      className={cn('rounded-lg border border-dashed px-3 py-2', running ? 'border-[color:var(--workspace-primary-500)]' : 'border-[color:var(--workspace-border-soft)]')}>
      <div className="flex items-center gap-2 text-[11.5px]">
        {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--workspace-accent-text)]" aria-hidden="true" />
          : <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" aria-hidden="true" />}
        <code className="min-w-0 flex-1 truncate font-mono text-[var(--workspace-text)]" title={turn.command}>$ {turn.command}</code>
        {turn.outcome && <RunOutcomeChip outcome={turn.outcome} />}
        {running && onInterrupt && (
          <button type="button" onClick={onInterrupt} title={copy.interruptHint} className={small}>
            <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />{copy.interrupt}
          </button>
        )}
        {running && <button type="button" onClick={onStopWaiting} title={copy.stopWaitingHint} className={small}>{copy.stopWaiting}</button>}
        {turn.state === 'captured' && (
          <button type="button" onClick={onRefresh} title={copy.refreshHint} aria-label={copy.refresh}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
      </div>
      {running && (
        <>
          <p className="mt-1.5 text-[11px] text-[var(--workspace-text-muted)]">{turn.auto ? `${copy.byAI} · ` : ''}{copy.running}</p>
          {turn.output && (
            <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--workspace-surface-900)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--workspace-text)]">{turn.output.split('\n').slice(-8).join('\n')}</pre>
          )}
        </>
      )}
      {turn.state === 'sent' && <p className="mt-1.5 text-[11px] text-[var(--workspace-text-muted)]">{t('ai.executed')}</p>}
      {turn.state === 'captured' && (
        <>
          {turn.outcome === 'input' && <p className="mt-1.5 text-[11px] text-[var(--workspace-status-warn-text)]">{copy.inputHint}</p>}
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]">
            <ChevronDown className={cn('h-3 w-3 transition-transform', !expanded && '-rotate-90')} aria-hidden="true" />
            {turn.lineCount ? fillCopy(copy.output, { count: turn.lineCount }) : copy.noOutput}
            {turn.durationMs !== undefined && <span className="text-[var(--workspace-text-subtle)]">· {fillCopy(copy.duration, { seconds: (turn.durationMs / 1000).toFixed(1) })}</span>}
            <span className="text-[var(--workspace-text-subtle)]">· {copy.sharedNext}</span>
          </button>
          {turn.output && (
            <pre className={cn('mt-1.5 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--workspace-surface-900)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--workspace-text)]', expanded ? 'max-h-80' : 'max-h-24')}>
              {turn.output}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

function AIPanelMenu({ items }: { items: Array<{ key: string; label: string; icon: typeof RotateCcw; disabled?: boolean; onSelect: () => void }> }) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={root} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} title={copy.more} aria-label={copy.more} onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-8 z-30 min-w-[180px] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-[var(--workspace-shadow-overlay)]">
          {items.map(({ key, label, icon: Icon, disabled, onSelect }) => (
            <button key={key} type="button" role="menuitem" disabled={disabled} onClick={() => { setOpen(false); onSelect() }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-40">
              <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-muted)]" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const MODE_ICON = { confirm: ShieldCheck, 'read-only': Zap, auto: FastForward } as const

function RunModePicker({ mode, onChange }: { mode: AIRunMode; onChange: (mode: AIRunMode) => void }) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const Icon = MODE_ICON[mode]
  return (
    <div ref={root} className="relative shrink-0">
      <button type="button" data-testid="ai-run-mode" data-mode={mode} aria-haspopup="menu" aria-expanded={open}
        title={`${copy.runMode}: ${copy.modes[mode].desc}`} onClick={() => setOpen((value) => !value)}
        className={cn('flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] transition-colors',
          mode === 'auto' ? 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]'
            : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text)] hover:border-[color:var(--workspace-border-strong)]')}>
        <Icon className="h-3 w-3" aria-hidden="true" />{copy.modes[mode].label}<ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label={copy.runMode} className="absolute bottom-8 left-0 z-30 w-[290px] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-[var(--workspace-shadow-overlay)]">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{copy.runMode}</p>
          {AI_RUN_MODES.map((item) => {
            const ItemIcon = MODE_ICON[item]
            return (
              <button key={item} type="button" role="menuitemradio" aria-checked={item === mode} onClick={() => { setOpen(false); onChange(item) }}
                className={cn('flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--workspace-surface-800)]', item === mode && 'bg-[var(--workspace-accent-subtle)]')}>
                <ItemIcon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', item === 'auto' ? 'text-[var(--workspace-status-warn-text)]' : 'text-[var(--workspace-accent-text)]')} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--workspace-text-strong)]">{copy.modes[item].label}{item === mode && <Check className="h-3 w-3 text-[var(--workspace-accent-text)]" aria-hidden="true" />}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--workspace-text-muted)]">{copy.modes[item].desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AutoWarning({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="ai-auto-warn-title" data-testid="ai-auto-warning"
      className="absolute inset-x-2.5 bottom-full z-30 mb-2 rounded-lg border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-surface-950)] p-3 shadow-[var(--workspace-shadow-overlay)]">
      <p id="ai-auto-warn-title" className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
        <TriangleAlert className="h-4 w-4 text-[var(--workspace-status-warn-text)]" aria-hidden="true" />{copy.autoWarnTitle}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-[11.5px] leading-relaxed text-[var(--workspace-text)]">
        {copy.autoWarnPoints.map((point) => <li key={point}>{fillCopy(point, { max: MAX_AUTO_STEPS })}</li>)}
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} autoFocus
          className="h-7 rounded-md px-3 text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]">{copy.cancel}</button>
        <button type="button" onClick={onConfirm}
          className="h-7 rounded-md bg-[var(--workspace-status-warn-text)] px-3 text-xs font-medium text-[var(--workspace-surface-950)] hover:opacity-90">{copy.autoWarnConfirm}</button>
      </div>
    </div>
  )
}

function AutoStatus({ state, onStop, onKeepGoing, onDismiss }: {
  state: { status: AutoStatusKind; steps: number }
  onStop: () => void
  onKeepGoing: () => void
  onDismiss: () => void
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const text = state.status === 'running' ? fillCopy(copy.autoRunning, { step: state.steps, max: MAX_AUTO_STEPS })
    : state.status === 'waiting' ? copy.autoWaiting
      : state.status === 'limit' ? fillCopy(copy.autoLimit, { max: MAX_AUTO_STEPS })
        : state.status === 'input' ? copy.autoInput
          : copy.autoUnsettled
  const warn = state.status === 'unsettled' || state.status === 'limit' || state.status === 'input'
  const action = 'h-6 shrink-0 rounded-md px-2 text-[11px] font-medium'
  return (
    <div data-testid="ai-auto-status" data-status={state.status} role="status"
      className={cn('mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px]',
        warn ? 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]'
          : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text)]')}>
      {state.status === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--workspace-accent-text)]" aria-hidden="true" />
        : <FastForward className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 leading-snug">{text}</span>
      {state.status === 'limit' && <button type="button" onClick={onKeepGoing} className={cn(action, 'bg-[var(--workspace-primary-500)] text-white hover:opacity-90')}>{copy.continueAuto}</button>}
      {state.status === 'unsettled' || state.status === 'input'
        ? <button type="button" onClick={onDismiss} className={cn(action, 'hover:bg-[var(--workspace-surface-800)]')}>{copy.dismiss}</button>
        : <button type="button" onClick={onStop} className={cn(action, 'border border-current hover:opacity-80')}>{copy.stopAuto}</button>}
    </div>
  )
}

function ContextChip({ icon: Icon, label, on, onToggle, hint, preview }: {
  icon: typeof Server
  label: string
  on: boolean
  onToggle: () => void
  hint: string
  /** Read when the popover opens, so it shows what the next message would carry. */
  preview: () => string
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [content, setContent] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const open = content !== null
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setContent(null) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setContent(null) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    // Not positioned itself, so the popover spans the whole input box instead of overflowing from the chip.
    <div ref={root} className="shrink-0">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={hint} data-on={on}
        onClick={() => setContent(open ? null : preview())}
        className={cn('flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] transition-colors',
          on ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
            : 'border-dashed border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-subtle)] line-through')}>
        <Icon className="h-3 w-3" aria-hidden="true" />{label}
      </button>
      {open && (
        <div role="dialog" aria-label={label} className="absolute inset-x-0 bottom-full z-30 mb-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-2.5 text-xs shadow-[var(--workspace-shadow-overlay)]">
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" aria-hidden="true" />
            <span className="flex-1 font-medium text-[var(--workspace-text-strong)]">{label}</span>
            <span className="text-[11px] text-[var(--workspace-text-muted)]">{copy.contextSend}</span>
            <button type="button" role="switch" aria-checked={on} aria-label={copy.contextSend} onClick={onToggle}
              className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-[var(--workspace-primary-500)]' : 'bg-[var(--workspace-surface-800)] ring-1 ring-inset ring-[color:var(--workspace-border-soft)]')}>
              <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left]', on ? 'left-3.5' : 'left-0.5')} />
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--workspace-text-muted)]">{hint}</p>
          <p className="mt-2 text-[10.5px] font-medium text-[var(--workspace-text-subtle)]">{copy.contextPreview}</p>
          <pre className={cn('mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--workspace-surface-900)] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--workspace-text)]', !on && 'opacity-50')}>
            {content || copy.contextEmpty}
          </pre>
        </div>
      )}
    </div>
  )
}
