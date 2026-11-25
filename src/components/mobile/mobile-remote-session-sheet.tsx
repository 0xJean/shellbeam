import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RotateCw,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import { fill } from '@/lib/locales/probe-install'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useMobileBackHandler } from '@/lib/mobile-back'
import {
  companionRemoteAiAction,
  companionRemoteAttachSession,
  companionRemoteDetachSession,
  companionRemoteResizeSession,
  companionRemoteSendInput,
  localizeSessionStatus,
  resolveDesktopSessionTitle,
  type DesktopAiSessionSnapshot,
  type RemoteAiMessage,
  type RemoteDesktopSessionInfo,
  type RemoteTerminalEvent,
} from '@/lib/companion'
import type { HostProfile } from '@/lib/hosts'
import { CommandRiskChip } from './command-risk-chip'
import { cn } from '@/lib/utils'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

interface MobileRemoteSessionSheetProps {
  session: RemoteDesktopSessionInfo
  desktopName: string
  canControl: boolean
  aiSnapshot: DesktopAiSessionSnapshot | null
  hosts: HostProfile[]
  onClose: () => void
}

/**
 * Full-screen mobile companion workspace rendered via Portal (`z-[110]`) above MobileBottomNav.
 * Mirrors both the desktop's live AI conversation (structured command cards, collapsible outputs,
 * one-thumb quick actions, mode switching, approval) and the live interactive terminal stream.
 */
export function MobileRemoteSessionSheet({
  session,
  desktopName,
  canControl,
  aiSnapshot,
  hosts,
  onClose,
}: MobileRemoteSessionSheetProps) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  useMobileBackHandler(true, onClose)

  const hasAiActivity = Boolean(
    aiSnapshot && (aiSnapshot.messages.length > 0 || aiSnapshot.pendingCommand || aiSnapshot.isStreaming),
  )
  const [tab, setTab] = useState<'ai' | 'terminal'>(hasAiActivity ? 'ai' : 'terminal')
  const [outputText, setOutputText] = useState('')
  const [sessionStatus, setSessionStatus] = useState(session.status)
  // Default to wrapping/fitting the mobile screen cleanly; user can toggle wide desktop columns anytime.
  const [fitPhone, setFitPhone] = useState(true)
  const [termInput, setTermInput] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [termAtBottom, setTermAtBottom] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({})

  const lastSeqRef = useRef(0)
  const termScrollRef = useRef<HTMLPreElement>(null)
  const aiScrollRef = useRef<HTMLDivElement>(null)
  const aiStickRef = useRef(true)

  useEffect(() => {
    setSessionStatus(session.status)
  }, [session.status])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    void companionRemoteAttachSession(session.sessionId, 0)
      .then((res) => {
        if (!active) return
        setSessionStatus(res.status)
        if (res.chunks.length > 0) {
          lastSeqRef.current = res.chunks[res.chunks.length - 1].seq
          setOutputText(stripAnsi(res.chunks.map((c) => c.data).join('')))
        }
      })
      .catch(() => {})

    void listen<RemoteTerminalEvent>('companion:terminal-event', (e) => {
      if (!active || e.payload.sessionId !== session.sessionId) return
      if (e.payload.kind === 'chunk') {
        if (e.payload.chunk.seq <= lastSeqRef.current) return
        lastSeqRef.current = e.payload.chunk.seq
        const nextChunk = stripAnsi(e.payload.chunk.data)
        setOutputText((prev) => (prev + nextChunk).slice(-120_000))
      } else if (e.payload.kind === 'status') {
        setSessionStatus(e.payload.status)
      }
    }).then((fn) => { unlisten = fn })

    return () => {
      active = false
      unlisten?.()
      void companionRemoteDetachSession(session.sessionId)
    }
  }, [session.sessionId])

  useEffect(() => {
    if (tab === 'terminal' && termAtBottom && termScrollRef.current) {
      termScrollRef.current.scrollTop = termScrollRef.current.scrollHeight
    }
  }, [outputText, tab, termAtBottom])

  useEffect(() => {
    if (tab === 'ai' && aiStickRef.current && aiScrollRef.current) {
      aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight
    }
  }, [aiSnapshot?.messages.length, aiSnapshot?.streamingText, aiSnapshot?.pendingCommand, tab])

  const { title: hostTitle } = resolveDesktopSessionTitle(session, aiSnapshot, hosts, copy.localShellLabel)
  const statusBadge = localizeSessionStatus(sessionStatus, copy)

  const sendRaw = async (data: string) => {
    if (!canControl) return
    await companionRemoteSendInput(session.sessionId, data).catch(() => {})
  }

  const handleToggleFit = async () => {
    const next = !fitPhone
    setFitPhone(next)
    if (canControl && next) {
      const approxCols = Math.max(40, Math.floor((window.innerWidth - 24) / 7.5))
      await companionRemoteResizeSession(session.sessionId, approxCols, 28).catch(() => {})
    }
  }

  const handleAiAction = async (
    action: 'run_pending' | 'cancel' | 'send_prompt' | 'set_mode',
    extra?: { prompt?: string; messageId?: string; mode?: string },
  ) => {
    if (!canControl) return
    setActionBusy(true)
    try {
      await companionRemoteAiAction({
        sessionId: session.sessionId,
        action,
        prompt: extra?.prompt,
        messageId: extra?.messageId,
        mode: extra?.mode,
      })
      if (action === 'send_prompt') {
        setAiInput('')
        aiStickRef.current = true
      }
    } finally {
      setActionBusy(false)
    }
  }

  const handleCopyCommand = async (id: string, cmd: string) => {
    const ok = await copyTextToClipboard(cmd)
    if (ok) {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600)
    }
  }

  const currentMode = aiSnapshot?.mode || 'confirm'
  const modeLabel = currentMode === 'auto'
    ? copy.modeAuto
    : currentMode === 'read-only'
      ? copy.modeReadOnly
      : copy.modeConfirm
  const nextMode = currentMode === 'confirm' ? 'auto' : currentMode === 'auto' ? 'read-only' : 'confirm'

  const messages = aiSnapshot?.messages ?? []
  const lastMsg = messages[messages.length - 1]
  const showQuickFollowUps = canControl && !aiSnapshot?.isStreaming && !aiSnapshot?.pendingCommand && lastMsg?.role === 'output'

  const quickKeys = useMemo(
    () => [
      { label: 'Ctrl+C', data: '\u0003' },
      { label: 'Tab', data: '\t' },
      { label: '↑', data: '\u001b[A' },
      { label: '↓', data: '\u001b[B' },
      { label: 'Esc', data: '\u001b' },
      { label: 'Ctrl+L', data: '\u000c' },
    ],
    [],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={hostTitle}
      data-testid="mobile-remote-session-sheet"
      className="fixed inset-0 z-[110] flex flex-col bg-[var(--workspace-bg-950)] text-[var(--workspace-text)]"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {/* Compact single-row header with inline AI / Terminal segmented toggle */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--workspace-text-muted)] active:bg-[var(--workspace-surface-800)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', statusBadge.live ? 'bg-emerald-400' : 'bg-[var(--workspace-text-subtle)]')} />
            <p className="truncate text-[14.5px] font-semibold text-[var(--workspace-text-strong)]">
              {hostTitle}
            </p>
          </div>
          <p className="truncate text-[11px] text-[var(--workspace-text-subtle)]">
            {desktopName} · {statusBadge.label}
          </p>
        </div>

        {/* Inline mode switcher saves a full row of vertical space */}
        <div className="flex shrink-0 items-center gap-1">
          {tab === 'terminal' && canControl && (
            <button
              type="button"
              onClick={() => void handleToggleFit()}
              title={fitPhone ? copy.keepDesktopWidth : copy.fitPhoneWidth}
              aria-label={fitPhone ? copy.keepDesktopWidth : copy.fitPhoneWidth}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--workspace-border-soft)]',
                fitPhone ? 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)]',
              )}
            >
              {fitPhone ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}

          <div className="inline-flex rounded-lg bg-[var(--workspace-surface-800)] p-0.5 text-[12px]">
            <button
              type="button"
              onClick={() => setTab('ai')}
              className={cn(
                'relative inline-flex h-7 items-center gap-1 rounded-md px-2.5 font-medium transition-colors',
                tab === 'ai'
                  ? 'bg-[var(--workspace-surface-950)] text-[var(--workspace-text-strong)] shadow-sm'
                  : 'text-[var(--workspace-text-muted)]',
              )}
            >
              <Sparkles className="h-3 w-3 text-[var(--workspace-accent-text)]" />
              <span>{copy.aiTabShort}</span>
              {aiSnapshot?.pendingCommand && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab('terminal')}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2.5 font-medium transition-colors',
                tab === 'terminal'
                  ? 'bg-[var(--workspace-surface-950)] text-[var(--workspace-text-strong)] shadow-sm'
                  : 'text-[var(--workspace-text-muted)]',
              )}
            >
              <Terminal className="h-3 w-3" />
              <span>{copy.terminalTabShort}</span>
            </button>
          </div>
        </div>
      </header>

      {!canControl && (
        <div className="flex shrink-0 items-center gap-1.5 bg-amber-500/12 px-3 py-1.5 text-[11.5px] text-amber-400">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span>{copy.readOnlyNotice}</span>
        </div>
      )}

      {tab === 'ai' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* AI Conversation Feed */}
          <div
            ref={aiScrollRef}
            onScroll={() => {
              const el = aiScrollRef.current
              if (!el) return
              aiStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5"
          >
            <div className="mx-auto w-full max-w-3xl space-y-3">
            {messages.length === 0 && !aiSnapshot?.isStreaming && !aiSnapshot?.pendingCommand && (
              <div className="mx-auto mt-10 flex max-w-xs flex-col items-center gap-2.5 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--workspace-text-muted)]">
                  {copy.aiEmptyHint}
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <RemoteAiMessageCard
                key={msg.id}
                msg={msg}
                canControl={canControl}
                actionBusy={actionBusy}
                copied={copiedId === msg.id}
                expanded={Boolean(expandedOutputs[msg.id])}
                onToggleExpand={() => setExpandedOutputs((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                onCopy={(cmd) => void handleCopyCommand(msg.id, cmd)}
                onRerun={(messageId) => void handleAiAction('run_pending', { messageId })}
              />
            ))}

            {aiSnapshot?.isStreaming && (
              <div className="rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--workspace-accent-text)]">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{aiSnapshot.stepLabel || copy.aiThinking}</span>
                </div>
                {aiSnapshot.streamingText && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[var(--workspace-text-strong)]">
                    {aiSnapshot.streamingText}
                    <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-[var(--workspace-accent-text)]" />
                  </pre>
                )}
              </div>
            )}

            {aiSnapshot?.pendingCommand && (
              <div className="space-y-2.5 rounded-2xl border border-amber-500/45 bg-amber-500/8 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-400">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{copy.pendingApprovalBadge}</span>
                  </div>
                  <CommandRiskChip command={aiSnapshot.pendingCommand} className="bg-transparent px-0" />
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-[#0b1020] p-2.5 font-mono text-[12px] leading-relaxed text-slate-100">
                  {aiSnapshot.pendingCommand}
                </pre>
                {canControl && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleAiAction('run_pending', { messageId: aiSnapshot.pendingMessageId ?? undefined })}
                    className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-[color:var(--workspace-primary-500)] text-[13.5px] font-medium text-[var(--workspace-primary-foreground)] active:opacity-80 disabled:opacity-40"
                  >
                    {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {copy.approveAndRun}
                  </button>
                )}
              </div>
            )}
            </div>
          </div>

          {/* Bottom Composer (Always above keyboard, never covered by bottom nav!) */}
          {canControl && (
            <div className="shrink-0 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 pb-2.5 pt-2">
              <div className="mx-auto w-full max-w-3xl space-y-2">
              {showQuickFollowUps && (
                <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleAiAction('send_prompt', { prompt: copy.explainOutputPrompt })}
                    className="h-7 shrink-0 rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[12px] font-medium text-[var(--workspace-text)] active:bg-[var(--workspace-surface-800)]"
                  >
                    {copy.explainOutput}
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleAiAction('send_prompt', { prompt: copy.nextStepPrompt })}
                    className="h-7 shrink-0 rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[12px] font-medium text-[var(--workspace-text)] active:bg-[var(--workspace-surface-800)]"
                  >
                    {copy.nextStep}
                  </button>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && aiInput.trim() && !actionBusy) {
                      void handleAiAction('send_prompt', { prompt: aiInput.trim() })
                    }
                  }}
                  placeholder={copy.sendFollowUpPlaceholder}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[14px] text-[var(--workspace-text-strong)] outline-none focus:border-[color:var(--workspace-primary-500)]"
                />
                {aiSnapshot?.isStreaming ? (
                  <button
                    type="button"
                    onClick={() => void handleAiAction('cancel')}
                    aria-label={copy.stopGenerating}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] active:opacity-80"
                  >
                    <Square className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!aiInput.trim() || actionBusy}
                    onClick={() => void handleAiAction('send_prompt', { prompt: aiInput.trim() })}
                    aria-label={copy.send}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)] active:opacity-80 disabled:opacity-40"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--workspace-text-subtle)]">
                <span className="truncate">{aiSnapshot?.modelLabel || desktopName}</span>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void handleAiAction('set_mode', { mode: nextMode })}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors',
                    currentMode === 'auto'
                      ? 'bg-amber-500/15 text-amber-400'
                      : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
                  )}
                >
                  <span>{modeLabel}</span>
                </button>
              </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <pre
            ref={termScrollRef}
            onScroll={() => {
              const el = termScrollRef.current
              if (!el) return
              setTermAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            }}
            className={cn(
              'min-h-0 flex-1 select-text overflow-auto bg-[#0b1020] p-3 font-mono text-[12px] leading-relaxed text-slate-100',
              fitPhone ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
            )}
          >
            {outputText || (sessionStatus.startsWith('closed') ? copy.sessionClosed : '…')}
          </pre>

          {!termAtBottom && (
            <button
              type="button"
              onClick={() => {
                setTermAtBottom(true)
                if (termScrollRef.current) {
                  termScrollRef.current.scrollTop = termScrollRef.current.scrollHeight
                }
              }}
              className="absolute bottom-28 right-4 inline-flex h-8 items-center gap-1 rounded-full border border-white/15 bg-slate-900/90 px-3 text-[11.5px] font-medium text-white shadow-lg"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {copy.scrollToBottom}
            </button>
          )}

          {canControl && (
            <div className="shrink-0 space-y-1.5 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 pb-2.5 pt-2">
              <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
                {quickKeys.map((k) => (
                  <button
                    key={k.label}
                    type="button"
                    onClick={() => void sendRaw(k.data)}
                    className="h-7 shrink-0 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 font-mono text-[11px] text-[var(--workspace-text)] active:bg-[var(--workspace-surface-800)]"
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={termInput}
                  onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && termInput) {
                      void sendRaw(`${termInput}\r`)
                      setTermInput('')
                    }
                  }}
                  placeholder={copy.typeCommandPlaceholder}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 font-mono text-[13.5px] text-[var(--workspace-text-strong)] outline-none focus:border-[color:var(--workspace-primary-500)]"
                />
                <button
                  type="button"
                  disabled={!termInput}
                  onClick={() => { void sendRaw(`${termInput}\r`); setTermInput('') }}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)] active:opacity-80 disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}

function RemoteAiMessageCard({
  msg,
  canControl,
  actionBusy,
  copied,
  expanded,
  onToggleExpand,
  onCopy,
  onRerun,
}: {
  msg: RemoteAiMessage
  canControl: boolean
  actionBusy: boolean
  copied: boolean
  expanded: boolean
  onToggleExpand: () => void
  onCopy: (cmd: string) => void
  onRerun: (messageId: string) => void
}) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']

  // 1. User message: compact right-aligned chat bubble
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-[color:var(--workspace-primary-500)] px-3.5 py-2 text-[13.5px] leading-relaxed text-[var(--workspace-primary-foreground)]">
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
      </div>
    )
  }

  // 2. Terminal output message: collapsible desktop-style output block
  if (msg.role === 'output') {
    const cleanOutput = msg.content.trim()
    const lines = cleanOutput ? cleanOutput.split('\n') : []
    const preview = lines.slice(0, 3).join('\n')
    const hasMore = lines.length > 3

    return (
      <div className="overflow-hidden rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/90">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex w-full items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-left"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />}
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--workspace-text-muted)]">
            $ {msg.command || ''}
          </span>
          <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-400">
            {copy.executedBadge}
          </span>
        </button>

        {cleanOutput && (
          <div className="bg-[#0b1020] px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-[10.5px] text-slate-400">
              <span>{fill(copy.outputLines, { count: lines.length })}</span>
              {hasMore && (
                <button type="button" onClick={onToggleExpand} className="text-[color:var(--workspace-accent-text)]">
                  {expanded ? copy.collapseOutput : copy.expandOutput}
                </button>
              )}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-slate-200">
              {expanded ? cleanOutput : preview}
            </pre>
          </div>
        )}
      </div>
    )
  }

  // 3. Assistant command card (matching Desktop AI Assistant hierarchy)
  if (msg.role === 'assistant' && msg.command) {
    return (
      <div className="overflow-hidden rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]">
        {msg.content && (
          <p className="border-b border-[color:var(--workspace-border-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--workspace-text)]">
            {msg.content}
          </p>
        )}
        <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-[#0b1020] px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-slate-100">
          {msg.command}
        </pre>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--workspace-border-soft)] px-3 py-2">
          <div className="flex items-center gap-2">
            {msg.executed && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400">
                <Check className="h-3 w-3" />
                {copy.executedBadge}
              </span>
            )}
            <CommandRiskChip command={msg.command} className="bg-transparent px-0" />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onCopy(msg.command!)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 text-[11px] text-[var(--workspace-text)] active:opacity-80"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              {copied ? copy.copied : copy.copyCommand}
            </button>
            {canControl && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => onRerun(msg.id)}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 text-[11px] text-[var(--workspace-text)] active:opacity-80 disabled:opacity-40"
              >
                <RotateCw className="h-3 w-3" />
                {copy.rerunCommand}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // 4. Plain assistant note / status / error card
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--workspace-text)]">
      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
    </div>
  )
}
