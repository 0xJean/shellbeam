import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '@/contexts/sessions-context'
import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
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
  vaultId?: string
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  presentation?: 'panel' | 'window' | 'mobile'
}

interface SidebarLocation {
  id: string
  label: string
  path: string
}

type Translate = (key: string, params?: Record<string, string | number>) => string

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

function getFileKind(fileName: string, t: Translate) {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (!ext || fileName === ext) return t('workspace.fileSystem.kind.file')
  const kinds: Record<string, string> = {
    sh: 'workspace.fileSystem.kind.shellScript', bash: 'workspace.fileSystem.kind.shellScript', zsh: 'workspace.fileSystem.kind.shellScript',
    js: 'workspace.fileSystem.kind.javascript', ts: 'workspace.fileSystem.kind.typescript', jsx: 'workspace.fileSystem.kind.javascript', tsx: 'workspace.fileSystem.kind.typescript',
    json: 'workspace.fileSystem.kind.json', yaml: 'workspace.fileSystem.kind.yaml', yml: 'workspace.fileSystem.kind.yaml', toml: 'workspace.fileSystem.kind.toml', xml: 'workspace.fileSystem.kind.xml',
    md: 'workspace.fileSystem.kind.markdown', txt: 'workspace.fileSystem.kind.text', log: 'workspace.fileSystem.kind.log',
    py: 'workspace.fileSystem.kind.python', rb: 'workspace.fileSystem.kind.ruby', go: 'workspace.fileSystem.kind.go', rs: 'workspace.fileSystem.kind.rust', java: 'workspace.fileSystem.kind.java',
    c: 'workspace.fileSystem.kind.cSource', cpp: 'workspace.fileSystem.kind.cppSource', cs: 'workspace.fileSystem.kind.csharpSource',
    html: 'workspace.fileSystem.kind.html', css: 'workspace.fileSystem.kind.css', scss: 'workspace.fileSystem.kind.scss',
    png: 'workspace.fileSystem.kind.image', jpg: 'workspace.fileSystem.kind.image', jpeg: 'workspace.fileSystem.kind.image', gif: 'workspace.fileSystem.kind.image', svg: 'workspace.fileSystem.kind.svg',
    zip: 'workspace.fileSystem.kind.archive', tar: 'workspace.fileSystem.kind.archive', gz: 'workspace.fileSystem.kind.archive', bz2: 'workspace.fileSystem.kind.archive',
    conf: 'workspace.fileSystem.kind.config', cfg: 'workspace.fileSystem.kind.config', ini: 'workspace.fileSystem.kind.config', env: 'workspace.fileSystem.kind.envConfig',
  }
  const kindKey = kinds[ext]
  return kindKey ? t(kindKey) : t('workspace.fileSystem.kind.extensionFile', { ext: ext.toUpperCase() })
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
  vaultId,
  hosts,
  resolveAuthSecret,
  presentation = 'panel',
}: WorkspaceFileSystemAppProps) {
  const { t } = useT()
  const activeHostId = selectedHostId ?? (
    selectedHostAddress
      ? hosts.find((host) => host.address === selectedHostAddress)?.id ?? null
      : null
  )
  const isEmbedded = presentation !== 'panel'
  const activeHost = activeHostId ? hosts.find((host) => host.id === activeHostId) ?? null : null
  const sessions = useSessions()
  const remoteFs = useMemo(
    () => (activeHost ? createRemoteFsClient(activeHost, resolveAuthSecret, { vaultId }) : null),
    [activeHost, resolveAuthSecret, vaultId],
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
  const [isMutating, setIsMutating] = useState(false)
  const [isOpeningFile, setIsOpeningFile] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [activeSidebarLocationId, setActiveSidebarLocationId] = useState<string | null>(null)
  const homeErrorMessage = t('workspace.fileSystem.error.home')
  const directoryErrorMessage = t('workspace.fileSystem.error.directory')

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
          setError(loadError instanceof Error ? loadError.message : homeErrorMessage)
        }
      } finally {
        if (!isCancelled) setIsLoadingHome(false)
      }
    }

    void loadHomeDir()

    return () => {
      isCancelled = true
    }
  }, [homeErrorMessage, remoteFs])

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
          setError(loadError instanceof Error ? loadError.message : directoryErrorMessage)
        }
      } finally {
        if (!isCancelled) setIsLoadingEntries(false)
      }
    }

    void loadEntries()

    return () => {
      isCancelled = true
    }
  }, [currentPath, directoryErrorMessage, remoteFs])

  const isLoading = isLoadingHome || isLoadingEntries
  const selectedEntry = selectedPath ? entries.find((entry) => entry.path === selectedPath) ?? null : null
  const sidebarLocations = useMemo<SidebarLocation[]>(() => {
    if (!homePath) return []
    const locations: SidebarLocation[] = [{ id: 'home', label: t('workspace.fileSystem.location.home'), path: homePath }]
    const parentPath = parentRemotePath(homePath)
    if (parentPath !== homePath) {
      locations.push({ id: 'parent', label: t('workspace.fileSystem.location.parent'), path: parentPath })
    }
    locations.push({ id: 'root', label: t('workspace.fileSystem.location.root'), path: '/' })
    return locations
  }, [homePath, t])

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
      setError(loadError instanceof Error ? loadError.message : directoryErrorMessage)
    } finally {
      setIsLoadingEntries(false)
    }
  }

  async function handleCreateFile() {
    if (!remoteFs || !currentPath || isMutating) return
    const name = window.prompt(t('workspace.fileSystem.prompt.newFile'))
    if (!name?.trim()) return
    await performMutation(async () => {
      if (await remoteFs.createFile(joinRemotePath(currentPath, name.trim())) === false) return false
      setStatusMessage(t('workspace.fileSystem.status.createdFile', { name: name.trim() }))
      return true
    })
  }

  async function handleCreateDir() {
    if (!remoteFs || !currentPath || isMutating) return
    const name = window.prompt(t('workspace.fileSystem.prompt.newFolder'))
    if (!name?.trim()) return
    await performMutation(async () => {
      if (await remoteFs.createDir(joinRemotePath(currentPath, name.trim())) === false) return false
      setStatusMessage(t('workspace.fileSystem.status.createdFolder', { name: name.trim() }))
      return true
    })
  }

  async function handleRenameSelected() {
    if (!remoteFs || !selectedEntry || !currentPath || isMutating) return
    const nextName = window.prompt(t('workspace.fileSystem.prompt.rename'), selectedEntry.fileName)
    if (!nextName?.trim() || nextName.trim() === selectedEntry.fileName) return
    await performMutation(async () => {
      if (await remoteFs.renamePath(selectedEntry.path, joinRemotePath(currentPath, nextName.trim())) === false) return false
      setStatusMessage(t('workspace.fileSystem.status.renamed', { name: nextName.trim() }))
      setSelectedPath(null)
      return true
    })
  }

  async function handleDeleteSelected() {
    if (!remoteFs || !selectedEntry || isMutating) return
    await performMutation(async () => {
      if (await remoteFs.deletePath(selectedEntry.path) === false) return false
      setStatusMessage(t('workspace.fileSystem.status.deleted', { name: selectedEntry.fileName }))
      setSelectedPath(null)
      if (editorPath === selectedEntry.path) {
        setEditorPath(null)
        setEditorContent('')
      }
      return true
    })
  }

  async function performMutation(execute: () => Promise<boolean>) {
    setIsMutating(true)
    setError(null)
    try {
      if (!await execute()) { setStatusMessage(t('files.operation.cancelled')); return }
      await refreshCurrentPath()
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError))
    } finally {
      setIsMutating(false)
    }
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
    if (!remoteFs || !editorPath || isMutating) return
    setIsSaving(true)
    setStatusMessage(null)
    try {
      await performMutation(async () => {
        if (await remoteFs.writeFile(editorPath, encodeBase64Utf8(editorContent)) === false) return false
        setStatusMessage(t('workspace.fileSystem.status.saved', { name: editorPath.split('/').pop() ?? editorPath }))
        return true
      })
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
        title={t('workspace.fileSystem.emptyTitle')}
        description={t('workspace.fileSystem.emptyDescription')}
      />
    )
  }

  const breadcrumbs = currentPath ? breadcrumbSegments(currentPath) : []
  const canGoUp = currentPath != null && currentPath !== '/'
  const folderCount = entries.filter((e) => e.isDir).length
  const fileCount = entries.filter((e) => !e.isDir).length

  const canPreviewSelected = !!selectedEntry && !selectedEntry.isDir && /\.(md|markdown|html?)$/i.test(selectedEntry.fileName)
  const folderSummary = t(folderCount === 1 ? 'workspace.fileSystem.count.folderOne' : 'workspace.fileSystem.count.folderMany', { count: folderCount })
  const fileSummary = t(fileCount === 1 ? 'workspace.fileSystem.count.fileOne' : 'workspace.fileSystem.count.fileMany', { count: fileCount })

  const toolbarBtn = cn(
    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workspace-border-glow)]',
    'disabled:pointer-events-none disabled:opacity-35',
    'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]',
  )

  return (
    <div
      data-testid="workspace-file-system-app"
      className={isEmbedded ? 'flex h-full min-h-0 flex-col' : 'flex min-h-0 flex-col gap-4'}
    >
      {!isEmbedded && (
        <div className="rounded-xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] px-6 py-5 text-[var(--workspace-text)] shadow-[var(--workspace-shadow-card)]">
          <div className="text-xs font-medium uppercase tracking-[0.22em] text-[var(--workspace-accent-text)]">{t('workspace.fileSystem.eyebrow')}</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{t('workspace.fileSystem.title')}</h2>
          <p className="mt-1 text-sm text-[var(--workspace-text-muted)]">{t('workspace.fileSystem.description')}</p>
        </div>
      )}

      <div
        className={cn(
          'flex flex-col overflow-hidden',
          isEmbedded
            ? 'min-h-0 flex-1'
            : 'min-h-[36rem] rounded-xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text)] shadow-[var(--workspace-shadow-card)]',
        )}
      >
        {/* Toolbar */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 border-b px-2 py-1.5',
            'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]',
          )}
        >
          {/* Navigation */}
          <button
            type="button"
            title={t('workspace.fileSystem.action.goUp')}
            aria-label={t('workspace.fileSystem.action.goUp')}
            disabled={!canGoUp || isLoading}
            onClick={() => currentPath && navigateToPath(parentRemotePath(currentPath))}
            className={toolbarBtn}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            title={t('workspace.fileSystem.action.refresh')}
            aria-label={t('workspace.fileSystem.action.refresh')}
            disabled={!currentPath || isLoading}
            onClick={() => void refreshCurrentPath()}
            className={toolbarBtn}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>

          {/* Divider */}
          <div className="mx-1 h-5 w-px shrink-0 bg-[var(--workspace-border-strong)]" />

          {/* Breadcrumb */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => navigateToPath('/')}
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors hover:underline',
                'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-accent-text)]',
              )}
            >
              /
            </button>
            {breadcrumbs.map((seg, i) => (
              <span key={seg.path} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
                <button
                  type="button"
                  onClick={() => navigateToPath(seg.path)}
                  className={cn(
                    'truncate rounded px-1.5 py-0.5 text-xs transition-colors hover:underline',
                    i === breadcrumbs.length - 1
                      ? 'font-medium text-[var(--workspace-text-strong)]'
                      : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-accent-text)]',
                  )}
                >
                  {seg.label}
                </button>
              </span>
            ))}
            {currentPath == null && (
              <span className="text-xs text-[var(--workspace-text-muted)]">
                {t('workspace.fileSystem.loading')}
              </span>
            )}
          </div>

          {/* Divider */}
          <div className="mx-1 h-5 w-px shrink-0 bg-[var(--workspace-border-strong)]" />

          {/* Actions */}
          <button
            type="button"
            title={t('workspace.fileSystem.action.newFile')}
            aria-label={t('workspace.fileSystem.action.newFile')}
            disabled={!currentPath || isMutating}
            onClick={() => void handleCreateFile()}
            className={toolbarBtn}
          >
            <FilePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title={t('workspace.fileSystem.action.newFolder')}
            aria-label={t('workspace.fileSystem.action.newFolder')}
            disabled={!currentPath || isMutating}
            onClick={() => void handleCreateDir()}
            className={toolbarBtn}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title={t('workspace.fileSystem.action.rename')}
            aria-label={t('workspace.fileSystem.action.rename')}
            disabled={!selectedEntry || isMutating}
            onClick={() => void handleRenameSelected()}
            className={toolbarBtn}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t('workspace.fileSystem.action.delete')}
            aria-label={t('workspace.fileSystem.action.delete')}
            disabled={!selectedEntry || isMutating}
            onClick={() => void handleDeleteSelected()}
            className={cn(toolbarBtn, 'hover:!bg-[var(--workspace-status-bad-bg)] hover:!text-[var(--workspace-status-bad-text)]')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canPreviewSelected}
            onClick={() => selectedEntry && void handlePreviewFile(selectedEntry)}
            className="ml-2 h-7 border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] px-2 text-xs text-[var(--workspace-text-muted)] hover:border-[var(--workspace-border-glow)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
          >
            {t('workspace.fileSystem.action.preview')}
          </Button>
        </div>

        {/* Body: sidebar + file list + inspector */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Sidebar */}
          <aside
            className={cn(
              'w-40 shrink-0 overflow-auto border-r px-2 py-3',
              'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]',
            )}
          >
            <div
              className={cn(
                'mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest',
                'text-[var(--workspace-text-subtle)]',
              )}
            >
              {t('workspace.fileSystem.locations')}
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
                        ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)] font-medium ring-1 ring-[var(--workspace-border-glow)]'
                        : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]',
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
              'bg-[var(--workspace-surface-900)]',
            )}
          >
            {/* Column headers */}
            <div
              className={cn(
                'sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_6rem_7rem] border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider',
                'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)]',
              )}
            >
              <div>{t('workspace.fileSystem.column.name')}</div>
              <div className="text-right">{t('workspace.fileSystem.column.size')}</div>
              <div className="text-right">{t('workspace.fileSystem.column.kind')}</div>
            </div>

            {/* Notifications */}
            {statusMessage && (
              <div
                className={cn(
                  'mx-3 mt-3 rounded-lg px-3 py-2 text-xs',
                  'border border-[var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]',
                )}
              >
                {statusMessage}
              </div>
            )}
            {error && (
              <div className="mx-3 mt-3 rounded-lg border border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[var(--workspace-status-bad-text)]">
                {error}
              </div>
            )}
            {isLoading && (
              <div className="px-3 py-6 text-sm text-[var(--workspace-text-muted)]">
                {isLoadingHome ? t('workspace.fileSystem.loadingHome') : t('workspace.fileSystem.loadingDirectory')}
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
                            ? 'bg-[var(--workspace-surface-row-selected)] text-[var(--workspace-text-strong)] ring-1 ring-inset ring-[var(--workspace-border-glow)]'
                            : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-text-strong)]',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {entry.isDir ? (
                            <Folder
                              className={cn(
                                'h-4 w-4 shrink-0',
                                'text-[var(--workspace-accent-text)]',
                              )}
                            />
                          ) : (
                            <File
                              className={cn(
                                'h-4 w-4 shrink-0',
                                'text-[var(--workspace-text-subtle)]',
                              )}
                            />
                          )}
                          <span className="truncate">{entry.fileName}</span>
                        </div>
                        <div
                          className={cn(
                            'text-right text-xs',
                            'text-[var(--workspace-text-muted)]',
                          )}
                        >
                          {entry.isDir ? '—' : formatFileSize(entry.size)}
                        </div>
                        <div
                          className={cn(
                            'text-right text-xs',
                            'text-[var(--workspace-text-muted)]',
                          )}
                        >
                          {entry.isDir ? t('workspace.fileSystem.kind.folder') : getFileKind(entry.fileName, t)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="px-3 py-8 text-sm text-[var(--workspace-text-muted)]">
                  {t('workspace.fileSystem.emptyDirectory')}
                </div>
              )
            )}
          </section>

          {/* Inspector */}
          <aside
            className={cn(
              'w-60 shrink-0 overflow-auto border-l px-4 py-4',
              'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)]',
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
                        'text-[var(--workspace-accent-text)]',
                      )}
                    />
                  ) : (
                    <File
                      className={cn(
                        'h-14 w-14',
                        'text-[var(--workspace-text-subtle)]',
                      )}
                    />
                  )}
                </div>
                <div
                  className={cn(
                    'truncate text-center text-sm font-semibold',
                    'text-[var(--workspace-text-strong)]',
                  )}
                >
                  {selectedEntry.fileName}
                </div>
                <div
                  className={cn(
                    'mt-3 space-y-1.5 rounded-lg border px-3 py-2.5 text-xs',
                    'border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-panel)] text-[var(--workspace-text-muted)]',
                  )}
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.column.kind')}</span>
                    <span className="text-right">{selectedEntry.isDir ? t('workspace.fileSystem.kind.folder') : getFileKind(selectedEntry.fileName, t)}</span>
                  </div>
                  {!selectedEntry.isDir && (
                    <div className="flex justify-between gap-2">
                      <span className="text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.column.size')}</span>
                      <span>{formatFileSize(selectedEntry.size)}</span>
                    </div>
                  )}
                  <div className="pt-0.5">
                    <span className="block text-[10px] text-[var(--workspace-text-subtle)]">
                      {t('workspace.fileSystem.path')}
                    </span>
                    <span className="mt-0.5 block break-all text-[10px]">{selectedEntry.path}</span>
                  </div>
                  {canPreviewSelected && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 w-full border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-border-glow)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)]"
                      onClick={() => void handlePreviewFile(selectedEntry)}
                    >
                      {t('workspace.fileSystem.previewInBrowser')}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  'rounded-lg border border-dashed px-3 py-8 text-center text-xs',
                  'border-[var(--workspace-border-soft)] text-[var(--workspace-text-subtle)]',
                )}
              >
                {t('workspace.fileSystem.selectPrompt')}
              </div>
            )}

            {/* Editor */}
            <div
              className={cn(
                'mb-2 mt-5 text-[10px] font-semibold uppercase tracking-widest',
                'text-[var(--workspace-text-subtle)]',
              )}
            >
              {t('workspace.fileSystem.editor')}
            </div>
            {editorPath ? (
              <div className="space-y-2">
                <div
                  className={cn(
                    'truncate text-xs',
                    'text-[var(--workspace-text-muted)]',
                  )}
                >
                  {editorPath.split('/').pop()}
                </div>
                <textarea
                  aria-label={t('workspace.fileSystem.editorLabel')}
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  className={cn(
                    'min-h-[14rem] w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:ring-1',
                    'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-input)] text-[var(--workspace-text)] focus:ring-[color:var(--workspace-primary-500)]',
                  )}
                />
                <Button size="sm" className="w-full" onClick={() => void handleSaveFile()} disabled={isSaving || isMutating}>
                  {isSaving ? t('workspace.fileSystem.saving') : t('workspace.fileSystem.saveFile')}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  'rounded-lg border border-dashed px-3 py-8 text-center text-xs',
                  'border-[var(--workspace-border-soft)] text-[var(--workspace-text-subtle)]',
                )}
              >
                {isOpeningFile ? t('workspace.fileSystem.openingFile') : t('workspace.fileSystem.doubleClickToEdit')}
              </div>
            )}
          </aside>
        </div>

        {/* Status bar */}
        <div
          className={cn(
            'flex shrink-0 items-center justify-between border-t px-4 py-1 text-[11px]',
            'border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]',
          )}
        >
          <span>
            {isLoading
              ? t('workspace.fileSystem.loading')
              : t('workspace.fileSystem.statusSummary', { folders: folderSummary, files: fileSummary })}
          </span>
          <span>{activeHost.name} · {activeHost.address}</span>
        </div>
      </div>
    </div>
  )
}
