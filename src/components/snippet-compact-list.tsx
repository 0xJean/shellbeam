import { useMemo, useState } from 'react'
import { Code2, Copy, Play, Search, X } from 'lucide-react'

import { SnippetCommandText } from '@/components/snippet-variable-fill'
import { useSnippetVariableFill } from '@/hooks/use-snippet-variable-fill'
import { useT } from '@/lib/i18n'
import type { SnippetEntry } from '@/lib/snippets'

interface SnippetCompactListProps {
  snippets: SnippetEntry[]
  onApply: (cmd: string) => void
  onRun: (cmd: string) => void
}

export function SnippetCompactList({ snippets, onApply, onRun }: SnippetCompactListProps) {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const variableFill = useSnippetVariableFill()

  const filtered = useMemo(() => {
    if (!search.trim()) return snippets
    const q = search.toLowerCase()
    return snippets.filter(
      (snippet) => snippet.name.toLowerCase().includes(q) || snippet.command.toLowerCase().includes(q),
    )
  }, [snippets, search])

  return (
    <div className="flex h-full flex-col">
      {variableFill.dialog}
      <div className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('snippets.search')}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]"
        />
        {search && (
          <button type="button" onClick={() => setSearch('')} className="text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text)]">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Code2 className="mx-auto h-8 w-8 text-[var(--workspace-text-subtle)] opacity-50" />
            <p className="mt-2 text-xs text-[var(--workspace-text-muted)]">
              {snippets.length === 0 ? t('snippets.noSnippets') : t('snippets.noMatches')}
            </p>
          </div>
        ) : (
          filtered.map((snippet) => (
            <div
              key={snippet.id}
              className="group flex items-start gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5 transition-colors hover:bg-[var(--workspace-surface-800)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-[var(--workspace-text-strong)]">{snippet.name}</p>
                <SnippetCommandText command={snippet.command} className="mt-0.5 block truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" />
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => variableFill.request(snippet.command, onApply, snippet.name)}
                  className="rounded p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]"
                  title={t('snippets.paste')}
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => variableFill.request(snippet.command, onRun, snippet.name)}
                  className="rounded p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[color:var(--workspace-accent-text)]"
                  title={t('rightSidebar.runSnippet')}
                >
                  <Play className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
