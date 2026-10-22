import { useEffect, useRef, useState, useCallback } from 'react'
import { useT } from '@/lib/i18n'
import { Clock, Sparkles, Loader2 } from 'lucide-react'
import { isAIConfigured, loadAISettings, streamAICommand, createAbortController } from '@/lib/ai'
import { cn } from '@/lib/utils'

interface SuggestBarProps {
  visible: boolean
  inputLine: string
  historyEntries: string[]
  terminalContext: string
  onAccept: (command: string) => void
  onDismiss: () => void
}

export function SuggestBar({ visible, inputLine, historyEntries, terminalContext, onAccept, onDismiss }: SuggestBarProps) {
  const { t } = useT()
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const historyMatches = inputLine.length >= 2
    ? [...new Set(historyEntries)].filter((h) => h.startsWith(inputLine) && h !== inputLine).slice(0, 5)
    : []

  const allSuggestions = [...historyMatches.map((h) => ({ type: 'history' as const, text: h })), ...aiSuggestions.map((a) => ({ type: 'ai' as const, text: a }))]

  const [scope, setScope] = useState({ inputLine, visible })
  if (scope.inputLine !== inputLine || scope.visible !== visible) {
    setScope({ inputLine, visible })
    setSelectedIdx(0); setAiSuggestions([]); setAiLoading(false)
  }
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [inputLine, visible])

  const fetchAiSuggestions = useCallback(() => {
    if (aiLoading || !inputLine) return
    const settings = loadAISettings()
    if (!isAIConfigured(settings)) return
    abortRef.current?.abort()
    const ctrl = createAbortController()
    abortRef.current = ctrl
    setAiLoading(true)
    setAiSuggestions([])
    let result = ''
    streamAICommand(settings, `Complete this command: ${inputLine}`, terminalContext, {
      onToken: (t) => { if (!ctrl.signal.aborted && abortRef.current === ctrl) result += t },
      onDone: () => {
        if (ctrl.signal.aborted || abortRef.current !== ctrl) return
        const cmds = result.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3)
        setAiSuggestions(cmds)
        setAiLoading(false)
      },
      onError: () => { if (!ctrl.signal.aborted && abortRef.current === ctrl) setAiLoading(false) },
    }, ctrl.signal)
  }, [inputLine, terminalContext, aiLoading])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!visible || allSuggestions.length === 0) return
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, allSuggestions.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)) }
      else if (e.key === 'Tab' && allSuggestions.length > 0) {
        e.preventDefault()
        onAccept(allSuggestions[selectedIdx].text)
      }
      else if (e.key === 'Escape') { onDismiss() }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, allSuggestions, selectedIdx, onAccept, onDismiss])

  useEffect(() => { return () => { abortRef.current?.abort() } }, [])

  if (!visible || (allSuggestions.length === 0 && !aiLoading)) return null

  return (
    <div className="absolute bottom-12 left-2 z-20 w-80 max-w-[calc(100%-1rem)] rounded-lg border border-border/60 bg-card/95 shadow-xl backdrop-blur-sm">
      <div className="max-h-40 overflow-y-auto p-1">
        {allSuggestions.map((s, i) => (
          <button
            key={`${s.type}-${i}`}
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
              i === selectedIdx ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/40',
            )}
            onClick={() => onAccept(s.text)}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            {s.type === 'history' ? <Clock className="h-3 w-3 shrink-0 opacity-50" /> : <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
            <span className="truncate font-mono">{s.text}</span>
          </button>
        ))}
        {aiLoading && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t('suggest.aiThinking')}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border/40 px-2 py-1">
        <span className="text-[10px] text-muted-foreground">{t('suggest.hint')}</span>
        {!aiLoading && isAIConfigured(loadAISettings()) && (
          <button type="button" onClick={fetchAiSuggestions} className="flex items-center gap-1 text-[10px] text-primary hover:underline">
            <Sparkles className="h-2.5 w-2.5" /> {t('suggest.aiSuggest')}
          </button>
        )}
      </div>
    </div>
  )
}
