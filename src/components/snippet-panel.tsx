import { useEffect, useMemo, useState } from 'react'
import {
  Code2,
  Plus,
  Search,
  Terminal,
  Copy,
  Trash2,
  Save,
  Tag,
  Clock,
  X,
  ChevronLeft,
  Play,
} from 'lucide-react'

import type { SnippetDraft, SnippetEntry } from '@/lib/snippets'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

const TAG_COLORS = [
  'bg-blue-500/15 text-blue-400',
  'bg-emerald-500/15 text-emerald-400',
  'bg-amber-500/15 text-amber-400',
  'bg-purple-500/15 text-purple-400',
  'bg-pink-500/15 text-pink-400',
  'bg-cyan-500/15 text-cyan-400',
  'bg-rose-500/15 text-rose-400',
  'bg-indigo-500/15 text-indigo-400',
]

function tagColor(tag: string) {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

interface SnippetPanelProps {
  snippets: SnippetEntry[]
  selectedSnippetId: string | null
  saving: boolean
  running: boolean
  onSelectSnippet: (id: string) => void
  onCreateSnippet: (payload: SnippetDraft) => Promise<void>
  onUpdateSnippet: (payload: SnippetEntry) => Promise<void>
  onDeleteSnippet: (id: string) => Promise<void>
  onApplySnippetCommand: (command: string) => void
  onRunSnippet: (id: string) => Promise<void>
}

export function SnippetPanel({
  snippets,
  selectedSnippetId,
  saving,
  running: _running,
  onSelectSnippet,
  onCreateSnippet,
  onUpdateSnippet,
  onDeleteSnippet,
  onApplySnippetCommand,
  onRunSnippet: _onRunSnippet,
}: SnippetPanelProps) {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [tags, setTags] = useState('')

  const selectedSnippet = useMemo(
    () => snippets.find((s) => s.id === selectedSnippetId) ?? null,
    [selectedSnippetId, snippets],
  )

  useEffect(() => {
    if (isCreating) { setName(''); setCommand(''); setTags(''); return }
    if (!selectedSnippet) return
    setName(selectedSnippet.name)
    setCommand(selectedSnippet.command)
    setTags(selectedSnippet.tags.join(', '))
  }, [selectedSnippet, isCreating])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const s of snippets) for (const t of s.tags) set.add(t)
    return Array.from(set).sort()
  }, [snippets])

  const filtered = useMemo(() => {
    let result = snippets
    if (filterTag) result = result.filter((s) => s.tags.includes(filterTag))
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
      )
    }
    return result
  }, [snippets, search, filterTag])

  function parseTags(input: string) {
    return input.split(',').map((t) => t.trim()).filter(Boolean)
  }

  function handleCreate() {
    if (!name.trim() || !command.trim()) return
    void onCreateSnippet({ name: name.trim(), command: command.trim(), tags: parseTags(tags) })
    setIsCreating(false)
  }

  function handleUpdate() {
    if (!selectedSnippet || !name.trim() || !command.trim()) return
    void onUpdateSnippet({ ...selectedSnippet, name: name.trim(), command: command.trim(), tags: parseTags(tags) })
  }

  function handleDelete() {
    if (!selectedSnippet) return
    void onDeleteSnippet(selectedSnippet.id)
  }

  function handleCopyCommand() {
    if (!command.trim()) return
    void navigator.clipboard.writeText(command)
  }

  const hasChanges = selectedSnippet && !isCreating && (
    name.trim() !== selectedSnippet.name ||
    command.trim() !== selectedSnippet.command ||
    parseTags(tags).join(',') !== selectedSnippet.tags.join(',')
  )

  const showDetail = isCreating || !!selectedSnippet

  return (
    <div className="flex h-full gap-0 overflow-hidden rounded-xl border max-md:flex-col md:flex-row">
      {/* ── Left: Snippet List ── */}
      <div className={cn(
        'flex flex-col border-b bg-muted/20 md:w-64 md:shrink-0 md:border-b-0 md:border-r 2xl:w-72',
        showDetail ? 'max-md:hidden' : 'max-md:flex-1',
      )}>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Code2 className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">{t('snippets.title')}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">{snippets.length}</span>
        </div>

        {/* Search */}
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snippets.search')}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Tag filter */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilterTag(filterTag === t ? null : t)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-all',
                  filterTag === t
                    ? 'ring-1 ring-primary ' + tagColor(t)
                    : tagColor(t) + ' opacity-60 hover:opacity-100',
                )}
              >
                {t}
              </button>
            ))}
            {filterTag && (
              <button
                type="button"
                onClick={() => setFilterTag(null)}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('snippets.clear')}
              </button>
            )}
          </div>
        )}

        {/* Snippet list */}
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Code2 className="mx-auto h-8 w-8 text-muted-foreground/30" />
              <p className="mt-2 text-xs text-muted-foreground">
                {snippets.length === 0 ? t('snippets.noSnippets') : t('snippets.noMatches')}
              </p>
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { onSelectSnippet(s.id); setIsCreating(false) }}
                className={cn(
                  'flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2.5 text-left transition-colors',
                  s.id === selectedSnippetId && !isCreating
                    ? 'bg-primary/5 border-l-2 border-l-primary'
                    : 'hover:bg-muted/50',
                )}
              >
                <span className="truncate text-[13px] font-medium">{s.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{s.command}</span>
                {s.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {s.tags.map((t) => (
                      <span key={t} className={cn('rounded-full px-1.5 py-px text-[9px] font-medium', tagColor(t))}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {/* New snippet button */}
        <div className="border-t p-2">
          <Button
            size="sm"
            className="w-full gap-1.5"
            onClick={() => { setIsCreating(true); setName(''); setCommand(''); setTags('') }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('snippets.newSnippet')}
          </Button>
        </div>
      </div>

      {/* ── Right: Detail / Editor ── */}
      <div className={cn(
        'flex min-w-0 flex-1 flex-col',
        !showDetail && 'max-md:hidden',
      )}>
        {!selectedSnippet && !isCreating ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Code2 className="h-7 w-7" />
            </div>
            <div>
              <p className="font-medium">
                {snippets.length === 0 ? t('snippets.createFirst') : t('snippets.selectSnippet')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {snippets.length === 0
                  ? t('snippets.saveDesc')
                  : t('snippets.chooseDesc')}
              </p>
            </div>
            {snippets.length === 0 && (
              <Button size="sm" className="gap-1.5" onClick={() => setIsCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                {t('snippets.newSnippet')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <button
                type="button"
                onClick={() => { setIsCreating(false); onSelectSnippet('') }}
                className="shrink-0 text-muted-foreground hover:text-foreground md:hidden"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {isCreating ? t('snippets.newSnippetTitle') : t('snippets.editSnippet')}
                </p>
                {!isCreating && selectedSnippet?.lastUsedAt && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {t('snippets.lastUsed', { date: new Date(selectedSnippet.lastUsedAt).toLocaleString() })}
                  </p>
                )}
              </div>
              {!isCreating && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCopyCommand}
                    disabled={!command.trim()}
                    title={t('snippets.copy')}
                    className="h-8 w-8 p-0 text-muted-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDelete}
                    disabled={saving}
                    title={t('snippets.deleteSnippet')}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>

            {/* Form */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('snippets.name')}</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('snippets.namePlaceholder')}
                />
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('snippets.command')}</label>
                <Textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={t('snippets.commandPlaceholder')}
                  className="min-h-[120px] flex-1 resize-none font-mono text-xs"
                />
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Tag className="h-3 w-3" />
                  {t('snippets.tags')}
                </label>
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder={t('snippets.tagsPlaceholder')}
                />
                {parseTags(tags).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {parseTags(tags).map((t) => (
                      <span key={t} className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', tagColor(t))}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 border-t px-4 py-3">
              {isCreating ? (
                <>
                  <Button
                    size="sm"
                    onClick={handleCreate}
                    disabled={saving || !name.trim() || !command.trim()}
                    className="gap-1.5"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {saving ? t('snippets.creating') : t('snippets.create')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setIsCreating(false)}>
                    {t('snippets.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    onClick={() => onApplySnippetCommand(command)}
                    disabled={!command.trim()}
                    className="gap-1.5"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    {t('snippets.paste')}
                  </Button>
                  {hasChanges && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleUpdate}
                      disabled={saving || !name.trim() || !command.trim()}
                      className="gap-1.5"
                    >
                      <Save className="h-3.5 w-3.5" />
                      {saving ? t('snippets.saving') : t('snippets.saveChanges')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function SnippetCompactList({ snippets, onApply, onRun }: {
  snippets: SnippetEntry[]
  onApply: (cmd: string) => void
  onRun: (cmd: string) => void
}) {
  const { t } = useT()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return snippets
    const q = search.toLowerCase()
    return snippets.filter(
      (s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q),
    )
  }, [snippets, search])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
          filtered.map((s) => (
            <div
              key={s.id}
              className="group flex items-start gap-2 border-b border-border/30 px-3 py-2.5 transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{s.name}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.command}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => onApply(s.command)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={t('snippets.paste')}
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onRun(s.command)}
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
