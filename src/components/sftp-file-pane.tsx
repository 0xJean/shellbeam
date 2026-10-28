import { useMemo, useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Folder,
  FileText,
  RefreshCw,
  ArrowUp,
  CornerLeftUp,
  Filter,
  Trash2,
  Pencil,
  FolderPlus,
  Check,
  X,
  Shield,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fill } from '@/lib/locales/probe-install'
import { sftpCopyFor } from '@/lib/locales/sftp-v3'
import { formatBytes } from '@/lib/sftp-transfers'
import { cn } from '@/lib/utils'

export type UnifiedEntry = {
  path: string
  fileName: string
  isDir: boolean
  size?: number
  modifiedAt?: number
}

const entryTimeFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function formatTime(ms?: number) {
  if (!ms) return '-'
  return entryTimeFormatter.format(ms)
}

export interface FilePaneProps {
  title: string
  icon: React.ReactNode
  badge?: React.ReactNode
  entries: UnifiedEntry[]
  currentDir: string
  loading: boolean
  selectedPaths: Set<string>
  onDirChange: (dir: string) => void
  onRefresh: () => void
  onGoUp: () => void
  onEnterDir: (path: string) => void
  onToggleSelect: (path: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  filter: string
  onFilterChange: (v: string) => void
  placeholder?: React.ReactNode
  onDelete?: (path: string) => void
  onDeletePaths?: (paths: string[]) => void
  onRename?: (oldPath: string, newName: string) => void
  onCreateDir?: (name: string) => void
  onChmod?: (path: string, mode: number) => void
  onDropFiles?: (files: FileList) => void
  mutationsDisabled?: boolean
}

export function FilePane({
  title, icon, badge, entries, currentDir, loading, selectedPaths,
  onDirChange, onRefresh, onGoUp, onEnterDir, onToggleSelect,
  onSelectAll, onClearSelection, filter, onFilterChange, placeholder,
  onDelete, onDeletePaths, onRename, onCreateDir, onChmod, onDropFiles, mutationsDisabled = false,
}: FilePaneProps) {
  const { t, locale } = useT()
  const c = sftpCopyFor(locale)
  const filtered = useMemo(() => {
    if (!filter.trim()) return entries
    const q = filter.toLowerCase()
    return entries.filter((e) => e.fileName.toLowerCase().includes(q))
  }, [entries, filter])

  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingDir, setCreatingDir] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [chmodPath, setChmodPath] = useState<string | null>(null)
  const [chmodValue, setChmodValue] = useState('755')
  const [dragging, setDragging] = useState(false)
  const [dragCount, setDragCount] = useState(0)

  const hasActions = !!(onDelete || onDeletePaths || onRename || onCreateDir || onChmod)
  const selectedEntry = selectedPaths.size === 1
    ? entries.find((e) => selectedPaths.has(e.path)) ?? null
    : null

  function startRename() {
    if (!selectedEntry || !onRename) return
    setRenamingPath(selectedEntry.path)
    setRenameValue(selectedEntry.fileName)
  }

  function confirmRename() {
    if (!renamingPath || !renameValue.trim() || !onRename) return
    onRename(renamingPath, renameValue.trim())
    setRenamingPath(null)
    setRenameValue('')
  }

  function confirmCreateDir() {
    if (!newDirName.trim() || !onCreateDir) return
    onCreateDir(newDirName.trim())
    setCreatingDir(false)
    setNewDirName('')
  }

  const loadingSkeleton = (
    <div data-testid="sftp-file-pane-skeleton" className="space-y-2 px-3 py-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          data-testid="sftp-file-row-skeleton"
          className="flex items-center gap-3 rounded-lg px-1 py-1.5"
        >
          <div className="h-3 w-3 animate-pulse rounded-sm bg-[var(--workspace-surface-700)]" />
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-[var(--workspace-surface-700)]" />
          <div className="min-w-0 flex-1">
            <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-[var(--workspace-surface-700)]" />
          </div>
          <div className="hidden w-16 shrink-0 sm:block">
            <div className="h-2.5 w-full animate-pulse rounded-full bg-[var(--workspace-surface-700)]" />
          </div>
          <div className="hidden w-28 shrink-0 lg:block">
            <div className="h-2.5 w-full animate-pulse rounded-full bg-[var(--workspace-surface-800)]" />
          </div>
        </div>
      ))}
    </div>
  )

  const iconButton = 'h-7 w-7 p-0 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]'
  const canDrop = !!onDropFiles && !mutationsDisabled
  const canGoUp = currentDir.replace(/\/$/, '').split('/').length > 1

  return (
    <div className="sb-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-[var(--workspace-text)]">
      <div className="flex min-h-[48px] items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2">
        <span className="shrink-0 text-[var(--workspace-text-muted)]">{icon}</span>
        <span className="shrink-0 truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{title}</span>
        {badge && (
          <span className="min-w-0 truncate rounded-md bg-[var(--workspace-surface-800)] px-2 py-0.5 text-xs text-[var(--workspace-text-muted)]">{badge}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="sm" className={iconButton} onClick={onGoUp} title={t('sftpPane.parentDir')}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className={iconButton} onClick={onRefresh} disabled={loading} title={c.refresh}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          {onCreateDir && (
            <Button variant="ghost" size="sm" className={iconButton} title={t('sftpPane.newFolder')}
              disabled={mutationsDisabled} onClick={() => { setCreatingDir(true); setNewDirName('') }}>
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          )}
          {onRename && (
            <Button variant="ghost" size="sm" className={iconButton} title={t('sftpPane.rename')}
              disabled={!selectedEntry || mutationsDisabled} onClick={startRename}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {onChmod && (
            <Button variant="ghost" size="sm" className={iconButton} title={t('sftpPane.chmod')}
              disabled={!selectedEntry || mutationsDisabled}
              onClick={() => { if (selectedEntry) { setChmodPath(selectedEntry.path); setChmodValue('755') } }}>
              <Shield className="h-3.5 w-3.5" />
            </Button>
          )}
          {(onDelete || onDeletePaths) && (
            <Button variant="ghost" size="sm" className={cn(iconButton, 'hover:text-[var(--workspace-status-bad)]')} title={t('sftpPane.delete')}
              disabled={selectedPaths.size === 0 || mutationsDisabled}
              onClick={() => {
                if (onDeletePaths) onDeletePaths([...selectedPaths])
                else for (const p of selectedPaths) onDelete?.(p)
              }}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {!hasActions && (
            <span className="ml-1 shrink-0 text-[11px] text-[var(--workspace-text-subtle)]">{entries.length} items</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-1.5">
        <input
          type="text"
          value={currentDir}
          onChange={(e) => onDirChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRefresh() }}
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-1 font-mono text-xs text-[var(--workspace-text-muted)] outline-none focus:bg-[var(--workspace-surface-800)] focus:text-[var(--workspace-text-strong)] focus:ring-1 focus:ring-[hsl(var(--primary)/0.4)]"
        />
        <label className="flex w-28 shrink-0 items-center gap-1.5 rounded-md bg-[var(--workspace-surface-800)] px-2 py-1 sm:w-36">
          <Filter className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" />
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder={t('sftpPane.filter')}
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]"
          />
        </label>
        {selectedPaths.size > 0 && (
          <span className="shrink-0 text-xs font-medium text-[var(--workspace-text-strong)]">{t('sftpPane.selected', { n: selectedPaths.size })}</span>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs font-medium text-[var(--workspace-text-subtle)]">
        <input
          type="checkbox"
          checked={filtered.length > 0 && selectedPaths.size === filtered.length}
          onChange={() => { if (selectedPaths.size === filtered.length) onClearSelection(); else onSelectAll() }}
          className="h-3 w-3 shrink-0 accent-[hsl(var(--primary))]"
        />
        <span className="min-w-0 flex-1">{t('sftpPane.name')}</span>
        <span className="hidden w-16 text-right sm:block">{t('sftpPane.size')}</span>
        <span className="hidden w-28 text-right lg:block">{t('sftpPane.modified')}</span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(e) => { if (canDrop) { e.preventDefault(); setDragging(true); setDragCount(e.dataTransfer?.items?.length ?? 0) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (canDrop && e.dataTransfer.files.length) onDropFiles?.(e.dataTransfer.files) }}>
      <div className="min-h-0 flex-1 overflow-auto">
        {chmodPath && onChmod && (
          <div className="flex items-center gap-1.5 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-accent-subtle)] px-3 py-1.5">
            <Shield className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
            <span className="text-xs text-[var(--workspace-text-muted)]">chmod</span>
            <input type="text" value={chmodValue} onChange={(e) => setChmodValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const m = parseInt(chmodValue, 8); if (!isNaN(m)) { onChmod(chmodPath, m); setChmodPath(null) } }
                if (e.key === 'Escape') setChmodPath(null)
              }}
              placeholder="755" autoFocus maxLength={4}
              className="w-16 bg-transparent font-mono text-xs outline-none" />
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0"
              onClick={() => { const m = parseInt(chmodValue, 8); if (!isNaN(m)) { onChmod(chmodPath, m); setChmodPath(null) } }}>
              <Check className="h-3 w-3 text-[var(--workspace-status-good)]" />
            </Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setChmodPath(null)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
        {creatingDir && (
          <div className="flex items-center gap-1.5 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-accent-subtle)] px-3 py-1.5">
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
            <input type="text" value={newDirName} onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmCreateDir(); if (e.key === 'Escape') setCreatingDir(false) }}
              placeholder={t('sftpPane.folderName')} autoFocus
              className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" />
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={confirmCreateDir}><Check className="h-3 w-3 text-[var(--workspace-status-good)]" /></Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setCreatingDir(false)}><X className="h-3 w-3" /></Button>
          </div>
        )}
        {placeholder ? placeholder : loading ? (
          loadingSkeleton
        ) : (
          <>
            {canGoUp && (
              <button type="button" onClick={onGoUp} title={c.parentDir}
                className="flex w-full items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-left text-xs text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] md:py-1.5">
                <span className="h-3 w-3 shrink-0" />
                <CornerLeftUp className="h-3.5 w-3.5 shrink-0" />
                <span>..</span>
              </button>
            )}
            {filtered.length === 0 ? (
              <p className="p-4 text-center text-xs text-[var(--workspace-text-subtle)]">{t('sftpPane.emptyDir')}</p>
            ) : filtered.map((entry) => (
              <div
                key={entry.path}
                className={cn(
                  'flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5 text-xs transition-colors md:py-1.5',
                  selectedPaths.has(entry.path)
                    ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_hsl(var(--primary))]'
                    : 'hover:bg-[var(--workspace-surface-800)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedPaths.has(entry.path)}
                  onChange={() => onToggleSelect(entry.path)}
                  className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] md:h-3 md:w-3"
                />
                {renamingPath === entry.path ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {entry.isDir ? <Folder className="h-4 w-4 shrink-0 text-[var(--workspace-accent-text)] md:h-3.5 md:w-3.5" /> : <FileText className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)] md:h-3.5 md:w-3.5" />}
                    <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenamingPath(null) }}
                      autoFocus className="min-w-0 flex-1 rounded bg-[var(--workspace-surface-800)] px-1 text-xs outline-none focus:ring-1 focus:ring-[hsl(var(--primary)/0.4)]" />
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={confirmRename}><Check className="h-3 w-3 text-[var(--workspace-status-good)]" /></Button>
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setRenamingPath(null)}><X className="h-3 w-3" /></Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      if (entry.isDir && window.matchMedia('(max-width: 767px)').matches) {
                        onEnterDir(entry.path)
                      } else {
                        onToggleSelect(entry.path)
                      }
                    }}
                    onDoubleClick={() => { if (entry.isDir) onEnterDir(entry.path) }}
                  >
                    {entry.isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-[var(--workspace-accent-text)] md:h-3.5 md:w-3.5" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)] md:h-3.5 md:w-3.5" />
                    )}
                    <span className="truncate text-[var(--workspace-text-strong)]">{entry.fileName}</span>
                  </button>
                )}
                <span className="hidden w-16 shrink-0 text-right font-mono text-[var(--workspace-text-muted)] sm:block">{entry.isDir ? '—' : formatBytes(entry.size)}</span>
                <span className="hidden w-28 shrink-0 text-right text-[var(--workspace-text-subtle)] lg:block">{formatTime(entry.modifiedAt)}</span>
              </div>
            ))}
          </>
        )}
      </div>
      {dragging && canDrop && (
        <div data-testid="sftp-drop-hint" className="pointer-events-none absolute inset-x-3 bottom-3 flex h-16 items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-[hsl(var(--primary))] bg-[var(--workspace-accent-subtle)] px-3 text-xs font-medium text-[var(--workspace-accent-text)]">
          <Upload className="h-4 w-4 shrink-0" />
          <span className="truncate">{dragCount > 0 ? fill(c.dropHint, { n: dragCount, dir: currentDir }) : fill(c.dropHintAny, { dir: currentDir })}</span>
        </div>
      )}
      </div>
    </div>
  )
}
