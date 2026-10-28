import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Code2,
  Plus,
  Search,
  Copy,
  Trash2,
  Pencil,
  Save,
  Tag,
  Clock,
  X,
  Check,
  AlertTriangle,
  Layers,
  Play,
  Info,
  Braces,
} from 'lucide-react'

import type { SnippetDraft, SnippetEntry } from '@/lib/snippets'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SnippetCommandText } from '@/components/snippet-variable-fill'
import { useSnippetVariableFill } from '@/hooks/use-snippet-variable-fill'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { snippetsV3Copy } from '@/lib/locales/snippets-v3'
import { parseSnippetVariables } from '@/lib/snippet-variables'

const TAG_TONES = [
  'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
  'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
  'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
  'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
]

function tagTone(tag: string) {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length]
}

type CategoryKey = 'all' | 'recent' | 'untagged' | `tag:${string}`
type SortKey = 'recent' | 'updated' | 'name'

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
  const { t, locale } = useT()
  const c = snippetsV3Copy[locale]
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<CategoryKey>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [isCreating, setIsCreating] = useState(false)
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null)
  const variableFill = useSnippetVariableFill()

  const editingSnippet = useMemo(
    () => snippets.find((s) => s.id === editingSnippetId) ?? null,
    [editingSnippetId, snippets],
  )

  const showEditDialog = isCreating || !!editingSnippet

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of snippets) for (const tg of s.tags) counts.set(tg, (counts.get(tg) ?? 0) + 1)
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [snippets])
  const untaggedCount = useMemo(() => snippets.filter((s) => s.tags.length === 0).length, [snippets])
  const recentCount = useMemo(() => snippets.filter((s) => s.lastUsedAt).length, [snippets])
  const activeCategory: CategoryKey =
    (category.startsWith('tag:') && !tagCounts.some(([tg]) => `tag:${tg}` === category)) ||
    (category === 'untagged' && untaggedCount === 0)
      ? 'all'
      : category

  const filtered = useMemo(() => {
    let result = snippets
    if (activeCategory === 'recent') result = result.filter((s) => s.lastUsedAt)
    else if (activeCategory === 'untagged') result = result.filter((s) => s.tags.length === 0)
    else if (activeCategory.startsWith('tag:')) {
      const tag = activeCategory.slice(4)
      result = result.filter((s) => s.tags.includes(tag))
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.tags.some((tg) => tg.toLowerCase().includes(q)),
      )
    }
    const sorted = [...result]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, locale))
    else if (sort === 'updated') sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    else sorted.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt)
    return sorted
  }, [snippets, search, activeCategory, sort, locale])

  function handleSave(draft: SnippetDraft & { tags: string[] }) {
    if (isCreating) {
      void onCreateSnippet(draft)
      setIsCreating(false)
    } else if (editingSnippet) {
      void onUpdateSnippet({ ...editingSnippet, ...draft })
      setEditingSnippetId(null)
    }
  }

  function handleDelete(snippetId: string) {
    void onDeleteSnippet(snippetId)
    setEditingSnippetId(null)
  }

  function handleCopyCommand(cmd: string) {
    void navigator.clipboard.writeText(cmd)
  }

  function openCreate() {
    setIsCreating(true)
    setEditingSnippetId(null)
  }

  function openEdit(snippetId: string) {
    if (!snippets.some((x) => x.id === snippetId)) return
    setIsCreating(false)
    setEditingSnippetId(snippetId)
  }

  function closeDialog() {
    setIsCreating(false)
    setEditingSnippetId(null)
  }

  function categoryButton(key: CategoryKey, label: string, count: number, icon: ReactNode) {
    const active = activeCategory === key
    return (
      <button
        key={key}
        type="button"
        aria-pressed={active}
        onClick={() => setCategory(key)}
        className={cn(
          'flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors',
          active
            ? 'bg-[var(--workspace-surface-row-selected)] font-medium text-[var(--workspace-text-strong)] shadow-[inset_3px_0_0_hsl(var(--primary))]'
            : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]',
        )}
      >
        <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5', active ? 'text-[color:var(--workspace-accent-text)]' : 'text-[var(--workspace-text-subtle)]')}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{count}</span>
      </button>
    )
  }

  const sortOptions: Array<[SortKey, string]> = [['recent', c.sortRecent], ['updated', c.sortUpdated], ['name', c.sortName]]

  return (
    <div data-tour="snippets-page" className="flex w-full flex-col">
      {showEditDialog && (
        <SnippetEditDialog
          key={editingSnippet?.id ?? 'new'}
          snippet={isCreating ? null : editingSnippet}
          saving={saving}
          onClose={closeDialog}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
      {variableFill.dialog}

      <div className="shrink-0 px-6 pb-4 pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('snippets.title')}</h2>
            <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">
              {snippets.length > 0 ? fill(c.summary, { count: snippets.length }) : t('snippets.saveDesc')}
              <span className="text-[var(--workspace-text-subtle)]"> · </span>
              <span data-tour="snippet-variables" className="font-mono text-[12px] text-[color:var(--workspace-status-warn-text)]">{c.variablesNote}</span>
            </p>
          </div>
          <Button data-tour="snippet-create" size="sm" onClick={openCreate} className="h-9 shrink-0 gap-1.5 bg-[color:var(--workspace-primary-500)] text-xs">
            <Plus className="h-3.5 w-3.5" /> {t('snippets.newSnippet')}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-6 pb-6 md:grid-cols-[188px_minmax(0,1fr)]">
        <nav aria-label={c.categories} data-testid="snippet-categories" className="flex flex-col gap-0.5 max-md:flex-row max-md:flex-wrap">
          {categoryButton('all', c.all, snippets.length, <Layers />)}
          {tagCounts.map(([tg, count]) => categoryButton(`tag:${tg}`, tg, count, <Tag />))}
          {untaggedCount > 0 && tagCounts.length > 0 && categoryButton('untagged', c.untagged, untaggedCount, <Code2 />)}
          <div className="mb-1 mt-3.5 px-2.5 text-[11px] font-medium text-[var(--workspace-text-subtle)] max-md:hidden">{c.smartGroups}</div>
          {categoryButton('recent', c.recent, recentCount, <Clock />)}
        </nav>

        <div className="flex min-w-0 flex-col">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={c.search} aria-label={t('snippets.search')}
                className="h-8 border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-9 text-[13px]" />
            </div>
            <div className="flex-1" />
            <div role="group" aria-label={c.sort} className="flex rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-0.5">
              {sortOptions.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={sort === key} onClick={() => setSort(key)}
                  className={cn('rounded px-2.5 py-1 text-xs transition-colors', sort === key ? 'bg-[var(--workspace-surface-700)] font-medium text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]')}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="sb-card flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--workspace-surface-800)]">
                <Code2 className="h-7 w-7 text-[var(--workspace-text-subtle)]" />
              </div>
              <p className="text-sm font-medium text-[var(--workspace-text-strong)]">
                {snippets.length === 0 ? t('snippets.createFirst') : t('snippets.noMatches')}
              </p>
              <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                {snippets.length === 0 ? t('snippets.saveDesc') : t('hosts.noMatchHint')}
              </p>
              {snippets.length === 0 && (
                <Button className="mt-5 gap-1.5" onClick={openCreate}>
                  <Plus className="h-4 w-4" /> {t('snippets.newSnippet')}
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 content-start gap-3 xl:grid-cols-2">
              {filtered.map((s) => (
                <SnippetCard key={s.id} snippet={s}
                  onApply={(cmd) => variableFill.request(cmd, onApplySnippetCommand, s.name)} onCopy={handleCopyCommand}
                  onEdit={openEdit} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTime(ts: number, locale: string) {
  return new Date(ts).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function SnippetCard({ snippet: s, onApply, onCopy, onEdit }: { snippet: SnippetEntry; onApply: (cmd: string) => void; onCopy: (cmd: string) => void; onEdit: (id: string) => void }) {
  const { t, locale } = useT()
  const c = snippetsV3Copy[locale]
  const [copied, setCopied] = useState(false)
  const variableCount = useMemo(() => parseSnippetVariables(s.command).length, [s.command])
  function handleCopy() { onCopy(s.command); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <div data-testid="snippet-card" className="sb-card group flex min-w-0 flex-col gap-2.5 p-3.5 transition-shadow hover:shadow-[var(--sb-card-shadow-hover)]">
      <div className="flex min-w-0 items-center gap-2">
        <Code2 className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
        <button type="button" onClick={() => onEdit(s.id)} className="min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold text-[var(--workspace-text-strong)] hover:underline">{s.name}</button>
        {s.tags.slice(0, 2).map((tg) => (
          <span key={tg} className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', tagTone(tg))}>{tg}</span>
        ))}
        {s.tags.length > 2 && <span title={s.tags.slice(2).join(', ')} className="shrink-0 text-[11px] text-[var(--workspace-text-subtle)]">{fill(c.moreTags, { count: s.tags.length - 2 })}</span>}
        <button type="button" onClick={() => onEdit(s.id)} title={t('snippets.editSnippet')} aria-label={c.edit}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text)] focus-visible:opacity-100 group-hover:opacity-100">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      <pre className="max-h-32 overflow-auto rounded-md bg-[var(--workspace-surface-900)] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--workspace-text)]">
        <SnippetCommandText command={s.command} />
      </pre>
      <div className="flex items-center gap-2.5 text-[11.5px] text-[var(--workspace-text-subtle)]">
        <span className="min-w-0 flex-1 truncate">
          {s.lastUsedAt ? fill(c.lastUsed, { time: formatTime(s.lastUsedAt, locale) }) : c.neverUsed}
          {variableCount > 0 && <span className="text-[color:var(--workspace-status-warn-text)]"> · {fill(c.variableCount, { count: variableCount })}</span>}
        </span>
        <button type="button" onClick={handleCopy} title={t('snippets.copy')} aria-label={copied ? c.copied : c.copy}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text)]">
          {copied ? <Check className="h-3.5 w-3.5 text-[color:var(--workspace-status-good)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={() => onApply(s.command)} title={t('snippets.paste')}
          className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--workspace-accent-subtle)] px-2.5 text-xs font-medium text-[color:var(--workspace-accent-text)] transition-opacity hover:opacity-85">
          <Play className="h-3.5 w-3.5" />{c.run}
        </button>
      </div>
    </div>
  )
}

function parseTags(input: string) {
  return input.split(/[,，]/).map((tg) => tg.trim()).filter(Boolean)
}

function SnippetEditDialog({ snippet, saving, onClose, onSave, onDelete }: {
  snippet: SnippetEntry | null
  saving: boolean
  onClose: () => void
  onSave: (draft: SnippetDraft & { tags: string[] }) => void
  onDelete: (id: string) => void
}) {
  const { t, locale } = useT()
  const c = snippetsV3Copy[locale]
  const [name, setName] = useState(snippet?.name ?? '')
  const [command, setCommand] = useState(snippet?.command ?? '')
  const [tags, setTags] = useState<string[]>(snippet?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const mirrorRef = useRef<HTMLPreElement>(null)
  const variables = useMemo(() => parseSnippetVariables(command), [command])
  const canSave = !saving && !!name.trim() && !!command.trim()

  function addTags(input: string) {
    const next = parseTags(input).filter((tg) => !tags.includes(tg))
    if (next.length) setTags([...tags, ...new Set(next)])
  }

  function handleTagInput(value: string) {
    if (/[,，]/.test(value)) {
      addTags(value)
      setTagDraft('')
    } else setTagDraft(value)
  }

  function handleTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && tagDraft.trim()) {
      event.preventDefault()
      addTags(tagDraft)
      setTagDraft('')
    } else if (event.key === 'Backspace' && !tagDraft && tags.length) setTags(tags.slice(0, -1))
  }

  function handleSave() {
    if (!canSave) return
    const finalTags = [...tags, ...parseTags(tagDraft).filter((tg) => !tags.includes(tg))]
    onSave({ name: name.trim(), command: command.trim(), tags: finalTags })
  }

  const fieldClass = 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)]'

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} labelledBy="snippet-edit-title">
      <DialogContent className="w-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-overlay)] md:!max-w-[560px]">
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-5">
            <div className="min-w-0">
              <h3 id="snippet-edit-title" className="text-lg font-semibold text-[var(--workspace-text-strong)]">
                {snippet ? t('snippets.editSnippet') : t('snippets.newSnippetTitle')}
              </h3>
              {snippet?.lastUsedAt && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--workspace-text-muted)]">
                  <Clock className="h-3 w-3" />
                  {t('snippets.lastUsed', { date: new Date(snippet.lastUsedAt).toLocaleString() })}
                </p>
              )}
            </div>
            <button type="button" onClick={onClose} aria-label={t('snippets.cancel')} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 px-5 pb-4 pt-2">
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-[var(--workspace-text)]">{t('snippets.name')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('snippets.namePlaceholder')} className={fieldClass} />
            </label>
            <div>
              <label htmlFor="snippet-command-input" className="mb-1.5 block text-[13px] text-[var(--workspace-text)]">{t('snippets.command')}</label>
              <div className="relative rounded-md bg-[var(--workspace-surface-900)]">
                <pre ref={mirrorRef} aria-hidden="true"
                  className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-2 font-mono text-xs leading-relaxed text-[var(--workspace-text-strong)] [scrollbar-gutter:stable]">
                  <SnippetCommandText command={`${command}\n`} />
                </pre>
                <textarea
                  id="snippet-command-input"
                  value={command}
                  spellCheck={false}
                  onChange={(e) => setCommand(e.target.value)}
                  onScroll={(e) => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop }}
                  placeholder={t('snippets.commandPlaceholder')}
                  className="relative block min-h-[120px] w-full resize-none whitespace-pre-wrap break-words rounded-md border border-[color:var(--workspace-border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-transparent caret-[var(--workspace-text-strong)] outline-none [scrollbar-gutter:stable] placeholder:text-[var(--workspace-text-subtle)] focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-subtle)]">
                <Braces className="h-3.5 w-3.5 shrink-0" />
                {variables.length > 0 ? (
                  <>
                    <span>{c.detected}</span>
                    {variables.map((v) => (
                      <span key={v.name} data-testid="snippet-detected-variable" className="rounded bg-[var(--workspace-status-warn-bg)] px-1.5 py-px font-mono text-[color:var(--workspace-status-warn-text)]">
                        {v.name}{v.defaultValue ? `=${v.defaultValue}` : ''}
                      </span>
                    ))}
                  </>
                ) : <span>{c.variablesHint}</span>}
              </div>
            </div>
            <div>
              <label htmlFor="snippet-tags-input" className="mb-1.5 block text-[13px] text-[var(--workspace-text)]">{t('snippets.tags')}</label>
              <div className={cn('flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 focus-within:ring-2 focus-within:ring-ring', fieldClass)}>
                {tags.map((tg) => (
                  <span key={tg} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', tagTone(tg))}>
                    {tg}
                    <button type="button" aria-label={fill(c.removeTag, { tag: tg })} onClick={() => setTags(tags.filter((x) => x !== tg))} className="opacity-70 hover:opacity-100">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input id="snippet-tags-input" value={tagDraft} onChange={(e) => handleTagInput(e.target.value)} onKeyDown={handleTagKey}
                  onBlur={() => { if (tagDraft.trim()) { addTags(tagDraft); setTagDraft('') } }}
                  placeholder={tags.length ? c.tagsPlaceholder : t('snippets.tagsPlaceholder')}
                  className="h-7 min-w-[8rem] flex-1 bg-transparent text-sm text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
              </div>
            </div>
            <p className="flex items-start gap-1.5 text-xs text-[var(--workspace-text-muted)]">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" />{c.sendNote}
            </p>
          </div>

          <div className="flex items-center gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3.5">
            {snippet && (confirmDel ? (
              <button type="button" onClick={() => onDelete(snippet.id)}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--workspace-status-bad-bg)] px-3 text-sm font-medium text-[color:var(--workspace-status-bad-text)]">
                <AlertTriangle className="h-3.5 w-3.5" />{c.confirmDelete}
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmDel(true)} title={t('snippets.deleteSnippet')}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--workspace-status-bad-bg)] px-3 text-sm font-medium text-[color:var(--workspace-status-bad-text)] hover:opacity-90">
                <Trash2 className="h-3.5 w-3.5" />{c.delete}
              </button>
            ))}
            <div className="flex-1" />
            <button type="button" onClick={onClose}
              className="h-8 rounded-md border border-[color:var(--workspace-border-soft)] px-3.5 text-sm font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-800)]">
              {t('snippets.cancel')}
            </button>
            {snippet ? (
              <button type="button" onClick={handleSave} disabled={!canSave}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[color:var(--workspace-primary-500)] px-3.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-50">
                <Save className="h-3.5 w-3.5" />
                {saving ? t('snippets.saving') : t('snippets.saveChanges')}
              </button>
            ) : (
              <button type="button" onClick={handleSave} disabled={!canSave}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[color:var(--workspace-primary-500)] px-3.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" />
                {saving ? t('snippets.creating') : t('snippets.create')}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { SnippetCompactList } from './snippet-compact-list'
