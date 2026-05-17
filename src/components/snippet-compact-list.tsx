import { useMemo, useState } from 'react'
import { Code2, Copy, Play, Search, X } from 'lucide-react'

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

  const filtered = useMemo(() => {
    if (!search.trim()) return snippets
    const q = search.toLowerCase()
    return snippets.filter(
      (snippet) => snippet.name.toLowerCase().includes(q) || snippet.command.toLowerCase().includes(q),
    )
  }, [snippets, search])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('snippets.search')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
        {search && (
          <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Code2 className="mx-auto h-8 w-8 text-muted-foreground/30" />
            <p className="mt-2 text-xs text-muted-foreground">
              {snippets.length === 0 ? t('snippets.noSnippets') : t('snippets.noMatches')}
            </p>
          </div>
        ) : (
          filtered.map((snippet) => (
            <div
              key={snippet.id}
              className="group flex items-start gap-2 border-b border-border/30 px-3 py-2.5 transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{snippet.name}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{snippet.command}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => onApply(snippet.command)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={t('snippets.paste')}
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onRun(snippet.command)}
                  className="rounded p-1 text-muted-foreground hover:bg-primary/20 hover:text-primary"
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
