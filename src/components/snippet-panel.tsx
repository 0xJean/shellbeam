import { useMemo, useState } from 'react'
import {
  Code2,
  Plus,
  Search,
  Terminal,
  Copy,
  Trash2,
  Pencil,
  Save,
  Tag,
  Clock,
  X,
  Play,
  Check,
  AlertTriangle,
} from 'lucide-react'

import type { SnippetDraft, SnippetEntry } from '@/lib/snippets'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
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
  saving,
  onCreateSnippet,
  onUpdateSnippet,
  onDeleteSnippet,
  onApplySnippetCommand,
}: SnippetPanelProps) {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [tags, setTags] = useState('')

  const editingSnippet = useMemo(
    () => snippets.find((s) => s.id === editingSnippetId) ?? null,
    [editingSnippetId, snippets],
  )

  const showEditDialog = isCreating || !!editingSnippet

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const s of snippets) for (const tg of s.tags) set.add(tg)
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
        s.tags.some((tg) => tg.toLowerCase().includes(q)),
      )
    }
    return result
  }, [snippets, search, filterTag])

  function parseTags(input: string) {
    return input.split(',').map((tg) => tg.trim()).filter(Boolean)
  }

  function handleCreate() {
    if (!name.trim() || !command.trim()) return
    void onCreateSnippet({ name: name.trim(), command: command.trim(), tags: parseTags(tags) })
    setIsCreating(false)
  }

  function handleUpdate() {
    if (!editingSnippet || !name.trim() || !command.trim()) return
    void onUpdateSnippet({ ...editingSnippet, name: name.trim(), command: command.trim(), tags: parseTags(tags) })
    setEditingSnippetId(null)
  }

  function handleDelete(snippetId: string) {
    void onDeleteSnippet(snippetId)
  }

  function handleCopyCommand(cmd: string) {
    void navigator.clipboard.writeText(cmd)
  }

  function openCreate() {
    setIsCreating(true)
    setEditingSnippetId(null)
    setName('')
    setCommand('')
    setTags('')
  }

  function openEdit(snippetId: string) {
    const s = snippets.find((x) => x.id === snippetId)
    if (!s) return
    setIsCreating(false)
    setEditingSnippetId(snippetId)
    setName(s.name)
    setCommand(s.command)
    setTags(s.tags.join(', '))
  }

  function closeDialog() {
    setIsCreating(false)
    setEditingSnippetId(null)
  }

  return (
    <div className="flex w-full flex-col">
      {/* Edit / Create Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(o) => { if (!o) closeDialog() }}>
        <DialogContent className="max-w-lg">
          <div className="flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Code2 className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {isCreating ? t('snippets.newSnippetTitle') : t('snippets.editSnippet')}
                  </h3>
                  {!isCreating && editingSnippet?.lastUsedAt && (
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {t('snippets.lastUsed', { date: new Date(editingSnippet.lastUsedAt).toLocaleString() })}
                    </p>
                  )}
                </div>
              </div>
              <button type="button" onClick={closeDialog} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Form */}
            <div className="space-y-5 px-6 py-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('snippets.name')}</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('snippets.namePlaceholder')} />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('snippets.command')}</label>
                <Textarea value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('snippets.commandPlaceholder')}
                  className="min-h-[120px] resize-none font-mono text-xs" />
              </div>
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Tag className="h-3 w-3" />{t('snippets.tags')}
                </label>
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('snippets.tagsPlaceholder')} />
                {parseTags(tags).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {parseTags(tags).map((tg) => (
                      <span key={tg} className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', tagColor(tg))}>{tg}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <button type="button" onClick={closeDialog}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                {t('snippets.cancel')}
              </button>
              {isCreating ? (
                <button type="button" onClick={handleCreate} disabled={saving || !name.trim() || !command.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50">
                  <Plus className="h-3.5 w-3.5" />
                  {saving ? t('snippets.creating') : t('snippets.create')}
                </button>
              ) : (
                <button type="button" onClick={handleUpdate} disabled={saving || !name.trim() || !command.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50">
                  <Save className="h-3.5 w-3.5" />
                  {saving ? t('snippets.saving') : t('snippets.saveChanges')}
                </button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Title section */}
      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('snippets.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('snippets.saveDesc')}</p>
          </div>
        </div>
      </div>

      {/* Toolbar + Content */}
      <div className="min-h-0 flex-1">
        <div className="flex min-h-[200px] min-w-0 flex-1 flex-col px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('snippets.search')} className="h-9 pl-9 text-sm" />
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-0.5">
                <button type="button" onClick={() => setFilterTag(null)} className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3', !filterTag ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {t('hosts.all')}
                </button>
                {allTags.map((tg) => (
                  <button key={tg} type="button" onClick={() => setFilterTag(filterTag === tg ? null : tg)} className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3', filterTag === tg ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {tg}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1" />
            <Button size="sm" onClick={openCreate} className="h-9 gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> {t('snippets.newSnippet')}
            </Button>
          </div>

          {/* Snippet list */}
          <div className="pb-6">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
                  <Code2 className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {snippets.length === 0 ? t('snippets.createFirst') : t('snippets.noMatches')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {snippets.length === 0 ? t('snippets.saveDesc') : t('hosts.noMatchHint')}
                </p>
                {snippets.length === 0 && (
                  <Button className="mt-5 gap-1.5" onClick={openCreate}>
                    <Plus className="h-4 w-4" /> {t('snippets.newSnippet')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((s) => (
                  <SnippetCard key={s.id} snippet={s}
                    onApply={onApplySnippetCommand} onCopy={handleCopyCommand}
                    onEdit={openEdit} onDelete={handleDelete} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SnippetCard({ snippet: s, onApply, onCopy, onEdit, onDelete }: { snippet: SnippetEntry; onApply: (cmd: string) => void; onCopy: (cmd: string) => void; onEdit: (id: string) => void; onDelete: (id: string) => void }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  function handleCopy() { onCopy(s.command); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <div className="overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/20">
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Code2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{s.name}</p>
          {s.tags.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {s.tags.map((tg) => (<span key={tg} className={cn('rounded-full px-1.5 py-px text-[9px] font-medium', tagColor(tg))}>{tg}</span>))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span role="button" tabIndex={0} onClick={() => onEdit(s.id)} title={t('snippets.editSnippet')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Pencil className="h-3.5 w-3.5" />
          </span>
          {confirmDel ? (
            <span role="button" tabIndex={0} onClick={() => { onDelete(s.id); setConfirmDel(false) }}
              className="flex h-8 items-center gap-1 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20">
              <AlertTriangle className="h-3 w-3" />{t('snippets.confirmDelete')}
            </span>
          ) : (
            <span role="button" tabIndex={0} onClick={() => setConfirmDel(true)} title={t('snippets.deleteSnippet')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
      <div className="mx-3 mb-3 mt-1 overflow-hidden rounded-lg bg-muted/50">
        <div className="flex items-center justify-between px-3 py-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">command</span>
          <div className="flex items-center gap-0.5">
            <span role="button" tabIndex={0} onClick={handleCopy} title={t('snippets.copy')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground">
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            </span>
            <span role="button" tabIndex={0} onClick={() => onApply(s.command)} title={t('snippets.paste')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground">
              <Terminal className="h-3 w-3" />
            </span>
          </div>
        </div>
        <pre className="max-h-32 overflow-auto px-3 pb-2.5 font-mono text-xs leading-relaxed text-foreground/80">{s.command}</pre>
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
