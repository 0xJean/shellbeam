import { useT } from '@/lib/i18n'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { cn } from '@/lib/utils'
import { AlertCircle, ArrowUp, Check, Copy, Loader2, Pencil, Play, RotateCcw, Sparkles, X } from 'lucide-react'
import { useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CommandRiskChip } from './command-risk-chip'

export interface AiSheetMessage {
  id: string
  role: 'user' | 'ai' | 'status'
  content: string
}

interface AiAssistantSheetProps {
  contextLabel?: string
  messages: AiSheetMessage[]
  streamingContent: string
  isStreaming: boolean
  error: string | null
  copiedId: string | null
  input: string
  onInputChange: (value: string) => void
  onInputKeyDown: (event: KeyboardEvent) => void
  onSubmit: () => void
  onCancel: () => void
  onRun: (message: AiSheetMessage, command: string) => void
  onCopy: (message: AiSheetMessage, command: string) => void
  onNewChat: () => void
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
}

const tinted = 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)] active:opacity-80'

export function AiAssistantSheet({
  contextLabel, messages, streamingContent, isStreaming, error, copiedId, input, onInputChange, onInputKeyDown,
  onSubmit, onCancel, onRun, onCopy, onNewChat, onClose, inputRef, scrollRef,
}: AiAssistantSheetProps) {
  const { t, locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden" data-testid="ai-assistant-sheet">
      <div className="absolute inset-0 bg-black/50" onClick={() => { onCancel(); onClose() }} aria-hidden="true" />
      <section role="dialog" aria-modal="true" aria-label={copy.aiAssistant}
        className="relative flex max-h-[85dvh] flex-col rounded-t-[20px] border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-overlay)]"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}>
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--workspace-border-strong)]" aria-hidden="true" />
        <header className="flex shrink-0 items-center gap-2 px-4 pt-1">
          <Sparkles className={cn('h-5 w-5 shrink-0 text-[var(--workspace-text-strong)]', isStreaming && 'animate-pulse')} aria-hidden="true" />
          <h2 className="shrink-0 text-[17px] font-semibold text-[var(--workspace-text-strong)]">{copy.aiAssistant}</h2>
          {contextLabel && <span className="min-w-0 truncate rounded-md bg-[var(--workspace-surface-800)] px-2 py-0.5 text-xs text-[var(--workspace-text-muted)]">{contextLabel}</span>}
          <span className="flex-1" />
          {messages.length > 0 && !isStreaming && (
            <button type="button" onClick={() => { setDrafts({}); setEditingId(null); onNewChat() }} aria-label={t('ai.newChat')}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--workspace-text-muted)] active:bg-[var(--workspace-surface-800)]">
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={() => { onCancel(); onClose() }}
            className="flex h-11 min-w-11 items-center justify-center px-1 text-[17px] text-[var(--workspace-accent-text)]">
            {copy.done}
          </button>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-3 pt-2">
          {messages.map((msg) => {
            if (msg.role === 'user') return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[color:var(--workspace-primary-500)] px-3.5 py-2 text-[15px] text-[var(--workspace-primary-foreground)]">{msg.content}</div>
              </div>
            )
            if (msg.role === 'status') return (
              <div key={msg.id} className="flex items-center gap-1.5 px-1 text-xs text-[var(--workspace-status-good-text)]">
                <Check className="h-3.5 w-3.5" /><span>{t('ai.executed')}</span>
              </div>
            )
            const command = drafts[msg.id] ?? msg.content
            const editing = editingId === msg.id
            return (
              <div key={msg.id} className="sb-card space-y-3 p-3.5">
                {editing ? (
                  <textarea value={command} aria-label={copy.editing} autoFocus rows={Math.min(6, command.split('\n').length + 1)}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [msg.id]: event.target.value }))}
                    className="block w-full resize-none rounded-xl border border-[color:var(--workspace-accent-text)] bg-[var(--workspace-surface-950)] px-3 py-2.5 font-mono text-[13px] leading-relaxed text-[var(--workspace-text-strong)] outline-none" />
                ) : (
                  <pre className="whitespace-pre-wrap break-all rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 py-2.5 font-mono text-[13px] leading-relaxed text-[var(--workspace-text-strong)]">{command}</pre>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <button type="button" onClick={() => { setEditingId(null); onRun(msg, command) }} disabled={!command.trim()}
                    className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[color:var(--workspace-primary-500)] text-sm font-medium text-[var(--workspace-primary-foreground)] active:opacity-80 disabled:opacity-40">
                    <Play className="h-4 w-4" />{t('ai.run')}
                  </button>
                  <button type="button" onClick={() => onCopy(msg, command)} className={cn('flex h-11 items-center justify-center gap-1.5 rounded-xl text-sm font-medium', tinted)}>
                    {copiedId === msg.id ? <><Check className="h-4 w-4" />{t('ai.copied')}</> : <><Copy className="h-4 w-4" />{t('ai.copy')}</>}
                  </button>
                  <button type="button" aria-pressed={editing} onClick={() => setEditingId(editing ? null : msg.id)} className={cn('flex h-11 items-center justify-center gap-1.5 rounded-xl text-sm font-medium', tinted)}>
                    {editing ? <><Check className="h-4 w-4" />{copy.done}</> : <><Pencil className="h-4 w-4" />{copy.edit}</>}
                  </button>
                </div>
                <CommandRiskChip command={command} className="bg-transparent px-0" />
              </div>
            )
          })}

          {streamingContent && (
            <div className="sb-card p-3.5">
              <pre className="whitespace-pre-wrap break-all rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 py-2.5 font-mono text-[13px] leading-relaxed text-[var(--workspace-text-strong)]">
                {streamingContent}<span className="inline-block h-3.5 w-1 animate-pulse bg-[color:var(--workspace-primary-500)]" />
              </pre>
            </div>
          )}
          {isStreaming && !streamingContent && (
            <div className="sb-card flex items-center gap-2 p-3.5 text-sm text-[var(--workspace-text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('ai.thinking')}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-[var(--workspace-status-bad-bg)] px-3 py-2.5 text-sm text-[var(--workspace-status-bad-text)]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 px-4 pt-1">
          <div className="flex min-w-0 flex-1 items-center rounded-full bg-[var(--workspace-surface-800)] pl-4 pr-1">
            <input ref={inputRef} type="text" value={input} disabled={isStreaming}
              onChange={(event) => onInputChange(event.target.value)} onKeyDown={onInputKeyDown}
              placeholder={messages.length ? copy.followUp : t('ai.describe')} enterKeyHint="send"
              className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
            {isStreaming ? (
              <button type="button" onClick={onCancel} aria-label={t('ai.cancel')}
                className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--workspace-text-muted)]">
                <X className="h-5 w-5" />
              </button>
            ) : (
              <button type="button" onClick={onSubmit} aria-label={t('ai.send')} disabled={!input.trim()}
                className="flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-40">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]"><ArrowUp className="h-4 w-4" /></span>
              </button>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
