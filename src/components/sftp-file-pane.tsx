import { useMemo, useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Folder,
  FileText,
  RefreshCw,
  ChevronUp,
  Search,
  Trash2,
  Pencil,
  FolderPlus,
  Check,
  X,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type UnifiedEntry = {
  path: string
  fileName: string
  isDir: boolean
  size?: number
  modifiedAt?: number
}

export function formatSize(bytes?: number) {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatTime(ms?: number) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface FilePaneProps {
  title: string
  icon: React.ReactNode
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
  onRename?: (oldPath: string, newName: string) => void
  onCreateDir?: (name: string) => void
  onChmod?: (path: string, mode: number) => void
  onDropFiles?: (files: FileList) => void
}

export function FilePane({
  title, icon, entries, currentDir, loading, selectedPaths,
  onDirChange, onRefresh, onGoUp, onEnterDir, onToggleSelect,
  onSelectAll, onClearSelection, filter, onFilterChange, placeholder,
  onDelete, onRename, onCreateDir, onChmod, onDropFiles,
}: FilePaneProps) {
  const { t } = useT()
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

  const hasActions = !!(onDelete || onRename || onCreateDir || onChmod)
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border/60 bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {icon}
        <span className="truncate text-xs font-semibold">{title}</span>
        {hasActions && (
          <div className="ml-auto flex items-center gap-0.5">
            {onCreateDir && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title={t('sftpPane.newFolder')}
                onClick={() => { setCreatingDir(true); setNewDirName('') }}>
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            )}
            {onRename && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title={t('sftpPane.rename')}
                disabled={!selectedEntry} onClick={startRename}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {onChmod && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title={t('sftpPane.chmod')}
                disabled={!selectedEntry}
                onClick={() => { if (selectedEntry) { setChmodPath(selectedEntry.path); setChmodValue('755') } }}>
                <Shield className="h-3.5 w-3.5" />
              </Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" title={t('sftpPane.delete')}
                disabled={selectedPaths.size === 0}
                onClick={() => { for (const p of selectedPaths) onDelete(p) }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
        {!hasActions && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{entries.length} items</span>
        )}
      </div>

      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" onClick={onGoUp} title={t('sftpPane.parentDir')}>
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <input
          type="text"
          value={currentDir}
          onChange={(e) => onDirChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRefresh() }}
          className="min-w-0 flex-1 truncate rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/40"
        />
        <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={t('sftpPane.filter')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
        {selectedPaths.size > 0 && (
          <span className="shrink-0 text-[10px] text-primary">{t('sftpPane.selected', { n: selectedPaths.size })}</span>
        )}
      </div>

      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <input
          type="checkbox"
          checked={filtered.length > 0 && selectedPaths.size === filtered.length}
          onChange={() => { selectedPaths.size === filtered.length ? onClearSelection() : onSelectAll() }}
          className="h-3 w-3 shrink-0"
        />
        <span className="min-w-0 flex-1">{t('sftpPane.name')}</span>
        <span className="hidden w-16 text-right sm:block">{t('sftpPane.size')}</span>
        <span className="hidden w-28 text-right lg:block">{t('sftpPane.modified')}</span>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-auto', dragging && 'ring-2 ring-inset ring-primary/50 bg-primary/5')}
        onDragOver={(e) => { if (onDropFiles) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (onDropFiles && e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files) }}>
        {chmodPath && onChmod && (
          <div className="flex items-center gap-1.5 border-b bg-primary/5 px-3 py-1.5">
            <Shield className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="text-xs text-muted-foreground">chmod</span>
            <input type="text" value={chmodValue} onChange={(e) => setChmodValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const m = parseInt(chmodValue, 8); if (!isNaN(m)) { onChmod(chmodPath, m); setChmodPath(null) } }
                if (e.key === 'Escape') setChmodPath(null)
              }}
              placeholder="755" autoFocus maxLength={4}
              className="w-16 bg-transparent font-mono text-xs outline-none" />
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0"
              onClick={() => { const m = parseInt(chmodValue, 8); if (!isNaN(m)) { onChmod(chmodPath, m); setChmodPath(null) } }}>
              <Check className="h-3 w-3 text-emerald-500" />
            </Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setChmodPath(null)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
        {creatingDir && (
          <div className="flex items-center gap-1.5 border-b bg-primary/5 px-3 py-1.5">
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <input type="text" value={newDirName} onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmCreateDir(); if (e.key === 'Escape') setCreatingDir(false) }}
              placeholder={t('sftpPane.folderName')} autoFocus
              className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" />
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={confirmCreateDir}><Check className="h-3 w-3 text-emerald-500" /></Button>
            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setCreatingDir(false)}><X className="h-3 w-3" /></Button>
          </div>
        )}
        {placeholder ? placeholder : loading ? (
          <div className="flex h-20 items-center justify-center">
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">{t('sftpPane.emptyDir')}</p>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.path}
              className={cn(
                'flex items-center gap-2 px-3 py-2.5 text-xs transition-colors hover:bg-muted/50 md:py-1',
                selectedPaths.has(entry.path) && 'bg-primary/5',
              )}
            >
              <input
                type="checkbox"
                checked={selectedPaths.has(entry.path)}
                onChange={() => onToggleSelect(entry.path)}
                className="h-4 w-4 shrink-0 md:h-3 md:w-3"
              />
              {renamingPath === entry.path ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {entry.isDir ? <Folder className="h-4 w-4 shrink-0 text-amber-500 md:h-3.5 md:w-3.5" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground md:h-3.5 md:w-3.5" />}
                  <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenamingPath(null) }}
                    autoFocus className="min-w-0 flex-1 rounded bg-muted/50 px-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary/40" />
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={confirmRename}><Check className="h-3 w-3 text-emerald-500" /></Button>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setRenamingPath(null)}><X className="h-3 w-3" /></Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
                    <Folder className="h-4 w-4 shrink-0 text-amber-500 md:h-3.5 md:w-3.5" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground md:h-3.5 md:w-3.5" />
                  )}
                  <span className="truncate font-mono">{entry.fileName}</span>
                </button>
              )}
              <span className="hidden w-16 shrink-0 text-right font-mono text-muted-foreground sm:block">{formatSize(entry.size)}</span>
              <span className="hidden w-28 shrink-0 text-right text-muted-foreground lg:block">{formatTime(entry.modifiedAt)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
