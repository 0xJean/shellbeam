import { useState, useRef, useCallback, useEffect } from 'react'
import { useT } from '@/lib/i18n'
import { Sparkles, Send, Copy, Play, X, Loader2, AlertCircle, RotateCcw, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { streamAICommand, loadAISettings, isAIConfigured, createAbortController } from '@/lib/ai'

interface AICommandBarProps {
  onExecuteCommand: (command: string) => void
  getTerminalContext: () => string
  visible: boolean
  onClose: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'ai' | 'status'
  content: string
  status?: 'executed' | 'copied'
}

export function AICommandBar({ onExecuteCommand, getTerminalContext, visible, onClose }: AICommandBarProps) {
  const { t } = useT()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamBuf = useRef('')

  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
    abortRef.current?.abort()
    abortRef.current = null
  }, [visible])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streamingContent])

  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null }, [])

  const handleSubmit = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    const settings = loadAISettings()
    if (!isAIConfigured(settings)) {
      setError(t('ai.notConfigured'))
      return
    }

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: prompt }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setError(null)
    setIsStreaming(true)
    setStreamingContent('')
    streamBuf.current = ''

    const ac = createAbortController()
    abortRef.current = ac
    ac.signal.addEventListener('abort', () => {
      if (abortRef.current !== ac) return
      setStreamingContent(''); setIsStreaming(false)
    }, { once: true })
    const context = getTerminalContext()

    await streamAICommand(settings, prompt, context, {
      onToken(token) {
        if (ac.signal.aborted || abortRef.current !== ac) return
        streamBuf.current += token
        setStreamingContent(streamBuf.current)
      },
      onDone() {
        if (ac.signal.aborted || abortRef.current !== ac) return
        const content = streamBuf.current.trim()
        if (content) {
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'ai', content }])
        }
        setStreamingContent('')
        setIsStreaming(false)
        abortRef.current = null
        setTimeout(() => inputRef.current?.focus(), 50)
      },
      onError(msg) {
        if (ac.signal.aborted || abortRef.current !== ac) return
        setError(msg)
        setStreamingContent('')
        setIsStreaming(false)
        abortRef.current = null
      },
    }, ac.signal)
  }, [input, isStreaming, getTerminalContext, t])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    streamBuf.current = ''
    setStreamingContent('')
    setIsStreaming(false)
  }, [])

  const handleExecute = useCallback((msg: ChatMessage) => {
    onExecuteCommand(msg.content + '\n')
    setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: 'status', content: msg.content, status: 'executed' }])
  }, [onExecuteCommand])

  const handleCopy = useCallback(async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopiedId(msg.id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch { /* clipboard not available */ }
  }, [])

  const handleNewChat = useCallback(() => {
    setMessages([])
    setError(null)
    setStreamingContent('')
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSubmit() }
    if (e.key === 'Escape') { if (isStreaming) handleCancel(); else onClose() }
  }, [handleSubmit, handleCancel, isStreaming, onClose])

  if (!visible) return null

  const hasMessages = messages.length > 0 || streamingContent || error

  return (
    <div className="relative flex flex-col border-b border-primary/15 bg-primary/[0.04]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      {hasMessages && (
        <div ref={scrollRef} className="max-h-64 overflow-y-auto px-3 pt-2.5 space-y-2">
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === 'user' && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary/15 px-3 py-1.5 text-xs text-foreground">{msg.content}</div>
                </div>
              )}
              {msg.role === 'ai' && (
                <div className="space-y-1.5">
                  <pre className="whitespace-pre-wrap rounded-lg border border-primary/10 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed text-blue-100">
                    {msg.content}
                  </pre>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => handleExecute(msg)}
                      className="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-semibold text-white transition-colors hover:bg-primary/80">
                      <Play className="h-2.5 w-2.5" /> {t('ai.run')}
                    </button>
                    <button type="button" onClick={() => void handleCopy(msg)}
                      className="flex h-6 items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2 text-[10px] font-medium text-blue-300 transition-colors hover:bg-primary/20">
                      {copiedId === msg.id ? <><Check className="h-2.5 w-2.5" /> {t('ai.copied')}</> : <><Copy className="h-2.5 w-2.5" /> {t('ai.copy')}</>}
                    </button>
                  </div>
                </div>
              )}
              {msg.role === 'status' && (
                <div className="flex items-center gap-1.5 text-[10px] text-emerald-400/70">
                  <Check className="h-3 w-3" />
                  <span>{t('ai.executed')}</span>
                </div>
              )}
            </div>
          ))}

          {streamingContent && (
            <div>
              <pre className="whitespace-pre-wrap rounded-lg border border-primary/10 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed text-blue-100">
                {streamingContent}<span className="inline-block h-3.5 w-1 animate-pulse bg-primary" />
              </pre>
            </div>
          )}

          {isStreaming && !streamingContent && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/10 bg-black/30 px-3 py-2 text-xs text-blue-300/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('ai.thinking')}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15">
          <Sparkles className={cn('h-4 w-4 text-primary', isStreaming && 'animate-pulse')} />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={messages.length ? t('ai.followUp') : t('ai.describe')}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button type="button" onClick={handleCancel} aria-label={t('ai.cancel')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={() => void handleSubmit()} aria-label={t('ai.send')} disabled={!input.trim()}
            className="flex h-7 items-center gap-1.5 rounded-lg bg-primary/20 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/30 disabled:opacity-30">
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
        {messages.length > 0 && !isStreaming && (
          <button type="button" onClick={handleNewChat} title={t('ai.newChat')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={() => { handleCancel(); onClose() }} aria-label={t('ai.close')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
