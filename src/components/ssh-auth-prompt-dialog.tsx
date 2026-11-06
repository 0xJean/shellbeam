import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { sshAuthPromptCopy } from '@/lib/locales/ssh-auth-prompt'

export interface SshAuthPrompt {
  id: string
  sessionId: string
  /** `target` or `jump`. */
  stage: string
  host: string
  port: number
  username: string
  instruction: string
  prompts: { text: string; echo: boolean }[]
}

export const SSH_AUTH_PROMPT_EVENT = 'ssh-auth-prompt'
export const SSH_AUTH_PROMPT_CLOSED_EVENT = 'ssh-auth-prompt-closed'

/**
 * Puts a server's sign-in questions (a one-time code, a second password) to
 * the user while the connection waits. Text from the server is shown as plain
 * text. Closing the dialog in any way other than Continue cancels the sign-in.
 */
export function SshAuthPromptDialog({ prompt, onAnswer }: { prompt: SshAuthPrompt; onAnswer: (answers: string[] | null) => void }) {
  const { locale } = useT()
  const copy = sshAuthPromptCopy[locale]
  const titleId = useId()
  const [values, setValues] = useState<string[]>(() => prompt.prompts.map(() => ''))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onAnswer(values)
  }
  const endpoint = `${prompt.username}@${prompt.host}${prompt.port === 22 ? '' : `:${prompt.port}`}`
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer(null) }} labelledBy={titleId}>
      <DialogContent className="sb-card md:w-[440px] md:max-w-[440px]">
        <form onSubmit={submit} className="space-y-4 p-5" data-testid="ssh-auth-prompt">
          <div className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]"><ShieldCheck className="h-4 w-4" /></span>
            <div className="min-w-0">
              <h3 id={titleId} className="text-base font-semibold text-[color:var(--workspace-text-strong)]">{copy.title}</h3>
              <p className="mt-1 break-all font-mono text-xs text-[color:var(--workspace-text-muted)]">
                {endpoint}{prompt.stage === 'jump' && <span className="ml-1.5 font-sans">· {copy.jump}</span>}
              </p>
            </div>
          </div>
          {prompt.instruction && <p className="whitespace-pre-wrap break-words rounded-md bg-[var(--workspace-surface-800)] px-3 py-2 text-[13px] text-[color:var(--workspace-text)]">{prompt.instruction}</p>}
          {prompt.prompts.map((field, index) => (
            <label key={index} className="block space-y-1.5">
              <span className="block whitespace-pre-wrap break-words text-[13px] font-medium text-[color:var(--workspace-text)]">{field.text || copy.response}</span>
              <Input autoFocus={index === 0} type={field.echo ? 'text' : 'password'} autoComplete={field.echo ? 'one-time-code' : 'off'}
                spellCheck={false} value={values[index] ?? ''} className="font-mono"
                onChange={(event) => { const next = [...values]; next[index] = event.target.value; setValues(next) }} />
            </label>
          ))}
          <p className="text-xs text-[color:var(--workspace-text-subtle)]">{copy.note}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onAnswer(null)}>{copy.cancel}</Button>
            <Button type="submit">{copy.continue}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Listens for the backend's sign-in questions and answers them one at a time. */
export function SshAuthPromptRuntime() {
  const [queue, setQueue] = useState<SshAuthPrompt[]>([])
  const current = queue[0]
  const currentRef = useRef(current)
  useEffect(() => { currentRef.current = current }, [current])

  const answer = useCallback((answers: string[] | null) => {
    const prompt = currentRef.current
    if (!prompt) return
    setQueue((items) => items.filter((item) => item.id !== prompt.id))
    void invoke('ssh_auth_prompt_respond', { payload: { id: prompt.id, answers } }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const opened = listen<SshAuthPrompt>(SSH_AUTH_PROMPT_EVENT, (event) => setQueue((items) => [...items, event.payload]))
    // The backend stopped waiting (timeout): the question is no longer open.
    const closed = listen<{ id: string }>(SSH_AUTH_PROMPT_CLOSED_EVENT, (event) => setQueue((items) => items.filter((item) => item.id !== event.payload.id)))
    return () => {
      void opened.then((stop) => stop())
      void closed.then((stop) => stop())
    }
  }, [])

  if (!current) return null
  return <SshAuthPromptDialog key={current.id} prompt={current} onAnswer={answer} />
}
