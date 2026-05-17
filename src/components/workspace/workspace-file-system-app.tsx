import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '@/contexts/sessions-context'
import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { createRemoteFsClient } from '@/lib/remote-fs'
import type { SftpEntry } from '@/lib/sftp'
import { cn } from '@/lib/utils'
import {
  ChevronLeft,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'

interface WorkspaceFileSystemAppProps {
  sessionId?: string
  selectedHostId?: string | null
  selectedHostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  presentation?: 'panel' | 'window' | 'mobile'
}

interface SidebarLocation {
  id: string
  label: string
  path: string
}

function joinRemotePath(basePath: string, name: string) {
  if (basePath === '/') return `/${name}`
  return `${basePath}/${name}`
}

function parentRemotePath(path: string) {
  if (path === '/') return '/'
  const parts = path.replace(/\/$/, '').split('/')
  parts.pop()
  return parts.join('/') || '/'
}

function decodeBase64Utf8(value: string) {
  return decodeURIComponent(escape(atob(value)))
}

function encodeBase64Utf8(value: string) {
  return btoa(unescape(encodeURIComponent(value)))
}

function formatFileSize(bytes: number | undefined) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function getFileKind(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (!ext || fileName === ext) return 'File'
  const kinds: Record<string, string> = {
    sh: 'Shell Script', bash: 'Shell Script', zsh: 'Shell Script',
    js: 'JavaScript', ts: 'TypeScript', jsx: 'JavaScript', tsx: 'TypeScript',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
    md: 'Markdown', txt: 'Text', log: 'Log',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
    c: 'C Source', cpp: 'C++ Source', cs: 'C# Source',
    html: 'HTML', css: 'CSS', scss: 'SCSS',
    png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', svg: 'SVG',
    zip: 'Archive', tar: 'Archive', gz: 'Archive', bz2: 'Archive',
    conf: 'Config', cfg: 'Config', ini: 'Config', env: 'Env Config',
  }
  return kinds[ext] ?? `${ext.toUpperCase()} File`
}

function breadcrumbSegments(path: string) {
  if (!path) return []
  if (path === '/') return []
  const segments = path.split('/').filter(Boolean)
  return segments.map((segment, index) => ({
    label: segment,
    path: `/${segments.slice(0, index + 1).join('/')}`,
  }))
}

function SidebarLocationIcon({ id }: { id: string }) {
  if (id === 'home') return <Home className="h-4 w-4 shrink-0" />
  if (id === 'root') return <HardDrive className="h-4 w-4 shrink-0" />
  return <Folder className="h-4 w-4 shrink-0" />
}

export function WorkspaceFileSystemApp({
  sessionId,
  selectedHostId = null,
  selectedHostAddress = null,
  hosts,
  resolveAuthSecret,
  presentation = 'panel',
}: WorkspaceFileSystemAppProps) {
  const activeHostId = selectedHostId ?? (
    selectedHostAddress
      ? hosts.find((host) => host.address === selectedHostAddress)?.id ?? null
      : null
  )
  const isEmbedded = presentation !== 'panel'
  const activeHost = activeHostId ? hosts.find((host) => host.id === activeHostId) ?? null : null
  const sessions = useSessions()
  const remoteFs = useMemo(
    () => (activeHost ? createRemoteFsClient(activeHost, resolveAuthSecret) : null),
    [activeHost, resolveAuthSecret],
  )

  const [homePath, setHomePath] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [isLoadingHome, setIsLoadingHome] = useState(false)
  const [isLoadingEntries, setIsLoadingEntries] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isOpeningFile, setIsOpeningFile] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [activeSidebarLocationId, setActiveSidebarLocationId] = useState<string | null>(null)

  function navigateToPath(path: string, sidebarLocationId?: string) {
    setActiveSidebarLocationId(sidebarLocationId ?? null)
    if (path === currentPath) return
    setCurrentPath(path)
    setEntries([])
    setSelectedPath(null)
    setEditorPath(null)
    setEditorContent('')
    setError(null)
    setStatusMessage(null)
    setIsLoadingEntries(true)
  }

  useEffect(() => {
    if (!remoteFs) {
      setHomePath(null)
      setCurrentPath(null)
      setEntries([])
      setError(null)
      setSelectedPath(null)
      setEditorPath(null)
      setEditorContent('')
      setStatusMessage(null)
      setActiveSidebarLocationId(null)
      setIsLoadingHome(false)
      return
    }

    let isCancelled = false
    const fsClient = remoteFs

    setHomePath(null)
    setCurrentPath(null)
    setEntries([])
    setError(null)
    setSelectedPath(null)
    setEditorPath(null)
    setEditorContent('')
    setStatusMessage(null)
    setActiveSidebarLocationId(null)

    async function loadHomeDir() {
      setIsLoadingHome(true)
      try {
        const nextHomePath = await fsClient.getHomeDir()
        if (!isCancelled) {
          setHomePath(nextHomePath)
          setCurrentPath(nextHomePath)
        }
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to resolve remote home directory')
        }
      } finally {
        if (!isCancelled) setIsLoadingHome(false)
      }
    }

    void loadHomeDir()

    return () => {
      isCancelled = true
    }
  }, [remoteFs])

  useEffect(() => {
    if (!remoteFs || !currentPath) {
      setEntries([])
      setIsLoadingEntries(false)
      return
    }

    let isCancelled = false
    const fsClient = remoteFs
    const path = currentPath

    async function loadEntries() {
      setIsLoadingEntries(true)
      setError(null)

      try {
        const nextEntries = await fsClient.listDir(path)
        if (!isCancelled) {
          setEntries(nextEntries)
          setSelectedPath((prev) => (prev && nextEntries.some((entry) => entry.path === prev) ? prev : null))
        }
      } catch (loadError) {
        if (!isCancelled) {
          setEntries([])
          setError(loadError instanceof Error ? loadError.message : 'Unable to load remote directory')
        }
      } finally {
        if (!isCancelled) setIsLoadingEntries(false)
      }
    }

    void loadEntries()

    return () => {
      isCancelled = true
    }
  }, [currentPath, remoteFs])

  const isLoading = isLoadingHome || isLoadingEntries
  const selectedEntry = selectedPath ? entries.find((entry) => entry.path === selectedPath) ?? null : null
  const sidebarLocations = useMemo<SidebarLocation[]>(() => {
    if (!homePath) return []
    const locations: SidebarLocation[] = [{ id: 'home', label: 'Home', path: homePath }]
    const parentPath = parentRemotePath(homePath)
    if (parentPath !== homePath) {
      locations.push({ id: 'parent', label: 'Parent', path: parentPath })
    }
    locations.push({ id: 'root', label: 'Root', path: '/' })
    return locations
  }, [homePath])

  async function refreshCurrentPath() {
    if (!remoteFs || !currentPath) return
    setIsLoadingEntries(true)
    setError(null)
    try {
      const nextEntries = await remoteFs.listDir(currentPath)
      setEntries(nextEntries)
      setSelectedPath((prev) => (prev && nextEntries.some((entry) => entry.path === prev) ? prev : null))
    } catch (loadError) {
      setEntries([])
      setError(loadError instanceof Error ? loadError.message : 'Unable to load remote directory')
    } finally {
      setIsLoadingEntries(false)
    }
  }

  async function handleCreateFile() {
    if (!remoteFs || !currentPath) return
    const name = window.prompt('New file name')
    if (!name?.trim()) return
    await remoteFs.createFile(joinRemotePath(currentPath, name.trim()))
    setStatusMessage(`Created file: ${name.trim()}`)
    await refreshCurrentPath()
  }

  async function handleCreateDir() {
    if (!remoteFs || !currentPath) return
    const name = window.prompt('New folder name')
    if (!name?.trim()) return
    await remoteFs.createDir(joinRemotePath(currentPath, name.trim()))
    setStatusMessage(`Created folder: ${name.trim()}`)
    await refreshCurrentPath()
  }

  async function handleRenameSelected() {
    if (!remoteFs || !selectedEntry || !currentPath) return
    const nextName = window.prompt('Rename entry', selectedEntry.fileName)
    if (!nextName?.trim() || nextName.trim() === selectedEntry.fileName) return
    await remoteFs.renamePath(selectedEntry.path, joinRemotePath(currentPath, nextName.trim()))
    setStatusMessage(`Renamed to: ${nextName.trim()}`)
    setSelectedPath(null)
    await refreshCurrentPath()
  }

  async function handleDeleteSelected() {
    if (!remoteFs || !selectedEntry) return
    if (!window.confirm(`Delete ${selectedEntry.fileName}?`)) return
    await remoteFs.deletePath(selectedEntry.path)
    setStatusMessage(`Deleted: ${selectedEntry.fileName}`)
    setSelectedPath(null)
    if (editorPath === selectedEntry.path) {
      setEditorPath(null)
      setEditorContent('')
    }
    await refreshCurrentPath()
  }

  async function handleOpenFile(entry: SftpEntry) {
    if (!remoteFs || entry.isDir) return
    setIsOpeningFile(true)
    setStatusMessage(null)
    try {
      const fileData = await remoteFs.readFile(entry.path)
      setEditorPath(entry.path)
      setEditorContent(decodeBase64Utf8(fileData.contentB64))
      setSelectedPath(entry.path)
    } finally {
      setIsOpeningFile(false)
    }
  }

  async function handleSaveFile() {
    if (!remoteFs || !editorPath) return
    setIsSaving(true)
    setStatusMessage(null)
    try {
      await remoteFs.writeFile(editorPath, encodeBase64Utf8(editorContent))
      setStatusMessage(`Saved: ${editorPath.split('/').pop()}`)
      await refreshCurrentPath()
    } finally {
      setIsSaving(false)
    }
  }

  async function handlePreviewFile(entry: SftpEntry) {
    if (!sessionId || !remoteFs || entry.isDir) return
    setIsOpeningFile(true)
    setStatusMessage(null)
    try {
      const fileData = await remoteFs.readFile(entry.path)
      const decoded = decodeBase64Utf8(fileData.contentB64)
      const lowerName = entry.fileName.toLowerCase()
      if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) {
        sessions.openSessionBrowserMarkdown(sessionId, decoded, {
          title: entry.fileName,
          presentation: 'window',
        })
      } else if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
        sessions.openSessionBrowserHtml(sessionId, decoded, {
          title: entry.fileName,
          presentation: 'window',
        })
      }
      sessions.setSessionWorkspaceApp(sessionId, 'browser')
      sessions.setSessionMode(sessionId, 'workspace')
    } finally {
      setIsOpeningFile(false)
    }
  }

  if (!activeHost) {
    return (
      <WorkspaceEmptyState
        title="File System"
        description="Connect a remote host to manage its filesystem here."
      />
    )
  }

  const breadcrumbs = currentPath ? breadcrumbSegments(currentPath) : []
  const canGoUp = currentPath != null && currentPath !== '/'
  const folderCount = entries.filter((e) => e.isDir).length
  const fileCount = entries.filter((e) => !e.isDir).length

  const canPreviewSelected = !!selectedEntry && !selectedEntry.isDir && /\.(md|markdown|html?)$/i.test(selectedEntry.fileName)

  const toolbarBtn = cn(
    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'disabled:pointer-events-none disabled:opacity-35',
    isEmbedded
      ? 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]'
      : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200',
  )

  return (
    <div
      data-testid="workspace-file-system-app"
      className={isEmbedded ? 'flex h-full min-h-0 flex-col' : 'flex min-h-0 flex-col gap-4'}
    >
      {!isEmbedded && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-6 py-5 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.5),0_10px_10px_-5px_rgba(0,0,0,0.4)]">
          <div className="text-xs font-medium uppercase tracking-[0.22em] text-slate-500">File System</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-100">Remote File System</h2>
          <p className="mt-1 text-sm text-slate-400">Browse and manage files on the remote host.</p>
        </div>
      )}

      <div
        className={cn(
          'flex flex-col overflow-hidden',
          isEmbedded
            ? 'min-h-0 flex-1'
            : 'min-h-[36rem] rounded-xl border border-slate-700 bg-[rgba(10,16,24,0.95)] text-slate-300 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.5),0_10px_10px_-5px_rgba(0,0,0,0.4)]',
        )}
      >
        {/* Toolbar */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 border-b px-2 py-1.5',
            isEmbedded
              ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]'
              : 'border-slate-700 bg-slate-800/80',
          )}
        >
          {/* Navigation */}
          <button
            type="button"
            title="Go Up"
            disabled={!canGoUp || isLoading}
            onClick={() => currentPath && navigateToPath(parentRemotePath(currentPath))}
            className={toolbarBtn}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Refresh"
            disabled={!currentPath || isLoading}
            onClick={() => void refreshCurrentPath()}
            className={toolbarBtn}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>

          {/* Divider */}
          <div className={cn('mx-1 h-5 w-px shrink-0', isEmbedded ? 'bg-[var(--workspace-border-strong)]' : 'bg-slate-700')} />

          {/* Breadcrumb */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => navigateToPath('/')}
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors hover:underline',
                isEmbedded ? 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              /
            </button>
            {breadcrumbs.map((seg, i) => (
              <span key={seg.path} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight className={cn('h-3.5 w-3.5 shrink-0', isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-600')} />
                <button
                  type="button"
                  onClick={() => navigateToPath(seg.path)}
                  className={cn(
                    'truncate rounded px-1.5 py-0.5 text-xs transition-colors hover:underline',
                    i === breadcrumbs.length - 1
                      ? isEmbedded ? 'font-medium text-[var(--workspace-text-strong)]' : 'font-medium text-slate-100'
                      : isEmbedded ? 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]' : 'text-slate-500 hover:text-slate-300',
                  )}
                >
                  {seg.label}
                </button>
              </span>
            ))}
            {currentPath == null && (
              <span className={cn('text-xs', isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-500')}>
                Loading…
              </span>
            )}
          </div>

          {/* Divider */}
          <div className={cn('mx-1 h-5 w-px shrink-0', isEmbedded ? 'bg-[var(--workspace-border-strong)]' : 'bg-slate-700')} />

          {/* Actions */}
          <button
            type="button"
            title="New File"
            disabled={!currentPath}
            onClick={() => void handleCreateFile()}
            className={toolbarBtn}
          >
            <FilePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="New Folder"
            disabled={!currentPath}
            onClick={() => void handleCreateDir()}
            className={toolbarBtn}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Rename"
            disabled={!selectedEntry}
            onClick={() => void handleRenameSelected()}
            className={toolbarBtn}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Delete"
            disabled={!selectedEntry}
            onClick={() => void handleDeleteSelected()}
            className={cn(toolbarBtn, 'hover:!bg-red-500/20 hover:!text-red-400')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canPreviewSelected}
            onClick={() => selectedEntry && void handlePreviewFile(selectedEntry)}
            className="ml-2 h-7 border-[var(--workspace-border-soft)] bg-transparent px-2 text-xs text-[var(--workspace-text-muted)]"
          >
            Preview
          </Button>
        </div>

        {/* Body: sidebar + file list + inspector */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Sidebar */}
          <aside
            className={cn(
              'w-40 shrink-0 overflow-auto border-r px-2 py-3',
              isEmbedded
                ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]'
                : 'border-slate-700 bg-slate-800/60',
            )}
          >
            <div
              className={cn(
                'mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest',
                isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-600',
              )}
            >
              Locations
            </div>
            <div className="space-y-0.5">
              {sidebarLocations.map((loc) => {
                const isActive = currentPath === loc.path
                  && (activeSidebarLocationId == null || activeSidebarLocationId === loc.id)
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => navigateToPath(loc.path, loc.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      isActive
                        ? isEmbedded
                          ? 'bg-[color:var(--workspace-primary-500)]/20 text-[color:var(--workspace-primary-400)] font-medium'
                          : 'bg-primary/20 text-primary font-medium'
                        : isEmbedded
                          ? 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]'
                          : 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200',
                    )}
                  >
                    <SidebarLocationIcon id={loc.id} />
                    <span className="truncate">{loc.label}</span>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* File list */}
          <section
            className={cn(
              'min-w-0 flex-1 overflow-auto',
              isEmbedded ? 'bg-[var(--workspace-surface-900)]' : 'bg-[rgba(8,14,22,0.9)]',
            )}
          >
            {/* Column headers */}
            <div
              className={cn(
                'sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_6rem_7rem] border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider',
                isEmbedded
                  ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)]'
                  : 'border-slate-700/80 bg-[rgba(8,14,22,0.95)] text-slate-500',
              )}
            >
              <div>Name</div>
              <div className="text-right">Size</div>
              <div className="text-right">Kind</div>
            </div>

            {/* Notifications */}
            {statusMessage && (
              <div
                className={cn(
                  'mx-3 mt-3 rounded-lg px-3 py-2 text-xs',
                  isEmbedded
                    ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]'
                    : 'bg-slate-800 text-slate-400',
                )}
              >
                {statusMessage}
              </div>
            )}
            {error && (
              <div className="mx-3 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
            {isLoading && (
              <div className={cn('px-3 py-6 text-sm', isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-500')}>
                {isLoadingHome ? 'Loading home directory…' : 'Loading directory…'}
              </div>
            )}

            {/* Entries */}
            {!isLoading && !error && (
              entries.length > 0 ? (
                <div>
                  {entries.map((entry) => {
                    const isSelected = selectedPath === entry.path
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => {
                          if (entry.isDir) {
                            navigateToPath(entry.path)
                            return
                          }
                          setSelectedPath(entry.path)
                        }}
                        onDoubleClick={() => {
                          if (entry.isDir) return
                          void handleOpenFile(entry)
                        }}
                        className={cn(
                          'grid w-full grid-cols-[minmax(0,1fr)_6rem_7rem] items-center px-3 py-1.5 text-left text-sm transition-colors',
                          isSelected
                            ? isEmbedded
                              ? 'bg-[color:var(--workspace-primary-500)]/20 text-[var(--workspace-text-strong)]'
                              : 'bg-primary/20 text-white'
                            : isEmbedded
                              ? 'hover:bg-[var(--workspace-surface-700)]'
                              : 'hover:bg-slate-800/70',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {entry.isDir ? (
                            <Folder
                              className={cn(
                                'h-4 w-4 shrink-0',
                                isEmbedded ? 'text-[color:var(--workspace-primary-400)]' : 'text-primary',
                              )}
                            />
                          ) : (
                            <File
                              className={cn(
                                'h-4 w-4 shrink-0',
                                isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-500',
                              )}
                            />
                          )}
                          <span className="truncate">{entry.fileName}</span>
                        </div>
                        <div
                          className={cn(
                            'text-right text-xs',
                            isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-500',
                          )}
                        >
                          {entry.isDir ? '—' : formatFileSize(entry.size)}
                        </div>
                        <div
                          className={cn(
                            'text-right text-xs',
                            isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-500',
                          )}
                        >
                          {entry.isDir ? 'Folder' : getFileKind(entry.fileName)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className={cn('px-3 py-8 text-sm', isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-500')}>
                  This directory is empty.
                </div>
              )
            )}
          </section>

          {/* Inspector */}
          <aside
            className={cn(
              'w-60 shrink-0 overflow-auto border-l px-4 py-4',
              isEmbedded
                ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]'
                : 'border-slate-700 bg-slate-800/60',
            )}
          >
            {/* File info */}
            {selectedEntry ? (
              <div>
                <div className="mb-3 flex justify-center">
                  {selectedEntry.isDir ? (
                    <Folder
                      className={cn(
                        'h-14 w-14',
                        isEmbedded ? 'text-[color:var(--workspace-primary-400)]' : 'text-primary',
                      )}
                    />
                  ) : (
                    <File
                      className={cn(
                        'h-14 w-14',
                        isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-500',
                      )}
                    />
                  )}
                </div>
                <div
                  className={cn(
                    'truncate text-center text-sm font-semibold',
                    isEmbedded ? 'text-[var(--workspace-text-strong)]' : 'text-slate-100',
                  )}
                >
                  {selectedEntry.fileName}
                </div>
                <div
                  className={cn(
                    'mt-3 space-y-1.5 rounded-lg border px-3 py-2.5 text-xs',
                    isEmbedded
                      ? 'border-[var(--workspace-border-soft)] text-[var(--workspace-text-muted)]'
                      : 'border-slate-700/60 text-slate-400',
                  )}
                >
                  <div className="flex justify-between gap-2">
                    <span className={isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-500'}>Kind</span>
                    <span className="text-right">{selectedEntry.isDir ? 'Folder' : getFileKind(selectedEntry.fileName)}</span>
                  </div>
                  {!selectedEntry.isDir && (
                    <div className="flex justify-between gap-2">
                      <span className={isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-500'}>Size</span>
                      <span>{formatFileSize(selectedEntry.size)}</span>
                    </div>
                  )}
                  <div className="pt-0.5">
                    <span className={cn('block text-[10px]', isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-500')}>
                      Path
                    </span>
                    <span className="mt-0.5 block break-all text-[10px]">{selectedEntry.path}</span>
                  </div>
                  {canPreviewSelected && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 w-full"
                      onClick={() => void handlePreviewFile(selectedEntry)}
                    >
                      Preview in Browser
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  'rounded-lg border border-dashed px-3 py-8 text-center text-xs',
                  isEmbedded
                    ? 'border-[var(--workspace-border-soft)] text-[var(--workspace-text-subtle)]'
                    : 'border-slate-700 text-slate-600',
                )}
              >
                Select a file or folder to inspect
              </div>
            )}

            {/* Editor */}
            <div
              className={cn(
                'mb-2 mt-5 text-[10px] font-semibold uppercase tracking-widest',
                isEmbedded ? 'text-[var(--workspace-text-subtle)]' : 'text-slate-600',
              )}
            >
              Editor
            </div>
            {editorPath ? (
              <div className="space-y-2">
                <div
                  className={cn(
                    'truncate text-xs',
                    isEmbedded ? 'text-[var(--workspace-text-muted)]' : 'text-slate-400',
                  )}
                >
                  {editorPath.split('/').pop()}
                </div>
                <textarea
                  aria-label="Remote File Editor"
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  className={cn(
                    'min-h-[14rem] w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:ring-1',
                    isEmbedded
                      ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text)] focus:ring-[color:var(--workspace-primary-500)]'
                      : 'border-slate-700 bg-slate-900 text-slate-300 focus:ring-primary',
                  )}
                />
                <Button size="sm" className="w-full" onClick={() => void handleSaveFile()} disabled={isSaving}>
                  {isSaving ? 'Saving…' : 'Save File'}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  'rounded-lg border border-dashed px-3 py-8 text-center text-xs',
                  isEmbedded
                    ? 'border-[var(--workspace-border-soft)] text-[var(--workspace-text-subtle)]'
                    : 'border-slate-700 text-slate-600',
                )}
              >
                {isOpeningFile ? 'Opening file…' : 'Double-click a file to edit it'}
              </div>
            )}
          </aside>
        </div>

        {/* Status bar */}
        <div
          className={cn(
            'flex shrink-0 items-center justify-between border-t px-4 py-1 text-[11px]',
            isEmbedded
              ? 'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]'
              : 'border-slate-700 bg-slate-800/60 text-slate-500',
          )}
        >
          <span>
            {isLoading
              ? 'Loading…'
              : `${folderCount} folder${folderCount !== 1 ? 's' : ''}, ${fileCount} file${fileCount !== 1 ? 's' : ''}`}
          </span>
          <span>{activeHost.name} · {activeHost.address}</span>
        </div>
      </div>
    </div>
  )
}
