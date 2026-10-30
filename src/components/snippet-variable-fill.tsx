import { useMemo, useState } from 'react'
import { Braces, Play, X } from 'lucide-react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { snippetsV3Copy } from '@/lib/locales/snippets-v3'
import { parseSnippetVariables, splitSnippetCommand, substituteSnippetVariables } from '@/lib/snippet-variables'
import { cn } from '@/lib/utils'

export function SnippetCommandText({ command, className }: { command: string; className?: string }) {
  const parts = useMemo(() => splitSnippetCommand(command), [command])
  return (
    <span className={className}>
      {parts.map((part, index) => part.kind === 'text'
        ? <span key={index}>{part.text}</span>
        : <span key={index} data-snippet-variable={part.name} className="text-[color:var(--workspace-status-warn-text)]">{part.text}</span>)}
    </span>
  )
}

export function SnippetVariableDialog({ command, name, onCancel, onSubmit }: {
  command: string
  name?: string
  onCancel: () => void
  onSubmit: (command: string) => void
}) {
  const { locale } = useT()
  const c = snippetsV3Copy[locale]
  const variables = useMemo(() => parseSnippetVariables(command), [command])
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(variables.map((variable) => [variable.name, variable.defaultValue ?? ''])))
  const resolved = substituteSnippetVariables(command, values)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }} labelledBy="snippet-variable-fill-title">
      <DialogContent className="w-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-overlay)] md:!max-w-md">
        <form
          data-testid="snippet-variable-fill"
          onSubmit={(event) => { event.preventDefault(); onSubmit(resolved) }}
          className="flex flex-col"
        >
          <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
            <div className="min-w-0">
              <h3 id="snippet-variable-fill-title" className="flex items-center gap-2 text-base font-semibold text-[var(--workspace-text-strong)]">
                <Braces className="h-4 w-4 text-[color:var(--workspace-accent-text)]" />{c.fillTitle}
              </h3>
              <p className="mt-0.5 truncate text-xs text-[var(--workspace-text-muted)]">
                {name ? fill(c.fillNamed, { name, count: variables.length }) : fill(c.fillDesc, { count: variables.length })}
              </p>
            </div>
            <button type="button" onClick={onCancel} aria-label={c.cancel} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text)]">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 px-5 pb-4">
            {variables.map((variable, index) => (
              <label key={variable.name} className="block">
                <span className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-mono font-medium text-[color:var(--workspace-status-warn-text)]">{variable.name}</span>
                  {variable.defaultValue !== undefined && variable.defaultValue !== '' && (
                    <span className="truncate text-[11px] text-[var(--workspace-text-subtle)]">{fill(c.defaultHint, { value: variable.defaultValue })}</span>
                  )}
                </span>
                <Input
                  autoFocus={index === 0}
                  value={values[variable.name] ?? ''}
                  placeholder={variable.defaultValue}
                  onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                  className="h-9 font-mono text-xs"
                />
              </label>
            ))}
            <div>
              <div className="mb-1 text-[11px] text-[var(--workspace-text-subtle)]">{c.preview}</div>
              <pre data-testid="snippet-variable-preview" className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--workspace-text)]">{resolved}</pre>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
            <button type="button" onClick={onCancel} className="h-8 rounded-md border border-[color:var(--workspace-border-soft)] px-3 text-sm text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]">{c.cancel}</button>
            <button type="submit" className={cn('flex h-8 items-center gap-1.5 rounded-md bg-[color:var(--workspace-primary-500)] px-3 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90')}>
              <Play className="h-3.5 w-3.5" />{c.submit}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
