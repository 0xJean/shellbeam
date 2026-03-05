import { useEffect, useRef, useState, useCallback } from 'react'
import { useT } from '@/lib/i18n'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'

interface TerminalSearchBarProps {
  searchAddon: SearchAddon | null
  onClose: () => void
}

export function TerminalSearchBar({ searchAddon, onClose }: TerminalSearchBarProps) {
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState<string>('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const doSearch = useCallback((q: string, direction: 'next' | 'prev') => {
    if (!searchAddon || !q) { setMatchCount(''); return }
    const found = direction === 'next'
      ? searchAddon.findNext(q, { caseSensitive: false, regex: false })
      : searchAddon.findPrevious(q, { caseSensitive: false, regex: false })
    setMatchCount(found ? '' : t('searchBar.noResults'))
  }, [searchAddon])

  useEffect(() => {
    if (query) doSearch(query, 'next')
    else { searchAddon?.clearDecorations(); setMatchCount('') }
  }, [query, searchAddon, doSearch])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch(query, e.shiftKey ? 'prev' : 'next')
    }
  }

  return (
    <div className="absolute right-3 top-10 z-20 flex items-center gap-1 rounded-lg border border-border/60 bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('searchBar.search')}
        className="h-6 w-40 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      {matchCount && <span className="text-[10px] text-muted-foreground">{matchCount}</span>}
      <button type="button" onClick={() => doSearch(query, 'prev')} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title={t('searchBar.prev')}>
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => doSearch(query, 'next')} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title={t('searchBar.next')}>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title={t('searchBar.close')}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
