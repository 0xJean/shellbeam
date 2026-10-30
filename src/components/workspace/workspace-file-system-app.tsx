import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessions } from '@/contexts/sessions-context'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceFilesCopy } from '@/lib/locales/workspace-files-tools'
import { createRemoteFsClient } from '@/lib/remote-fs'
import type { SftpEntry } from '@/lib/sftp'
import { cn } from '@/lib/utils'
import {
  ArrowUp,
  ChevronRight,
  CornerLeftUp,
  Eye,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  HardDrive,
  House,
  Info,
  Pencil,
  RotateCw,
  Save,
  Trash2,
  X,
  type LucideIcon,
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
  if (id === 'home') return <House className="h-4 w-4 shrink-0" />
  if (id === 'parent') return <CornerLeftUp className="h-4 w-4 shrink-0" />
  if (id === 'root') return <HardDrive className="h-4 w-4 shrink-0" />
  return <Folder className="h-4 w-4 shrink-0" />
}

const FILE_ICON_GROUPS: Array<[LucideIcon, string[]]> = [
  [FileCog, ['conf', 'cfg', 'ini', 'yaml', 'yml', 'toml', 'json', 'xml', 'service']],
  [FileText, ['md', 'markdown', 'txt', 'log', 'types']],
  [FileCode, ['sh', 'bash', 'zsh', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'html', 'htm', 'css', 'scss', 'php', 'sql']],
  [FileImage, ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']],
  [FileArchive, ['zip', 'tar', 'gz', 'bz2', 'xz', 'tgz', '7z']],
  [FileKey, ['env', 'pem', 'key', 'crt', 'htpasswd']],
]

function getFileIcon(entry: SftpEntry): LucideIcon {
  if (entry.isDir) return Folder
  const lower = entry.fileName.toLowerCase()
  if (lower.startsWith('.env') || lower.startsWith('.ht')) return FileKey
  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : ''
  return FILE_ICON_GROUPS.find(([, exts]) => exts.includes(ext))?.[0] ?? (lower.endsWith('_params') ? FileCode : File)
}

function formatModifiedAt(value: number | undefined, locale: string) {
  if (!value) return null
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value < 1e11 ? value * 1000 : value)
}

const MAX_RECENT_PATHS = 5

export function WorkspaceFileSystemApp({
  sessionId,
  selectedHostId = null,
  selectedHostAddress = null,
  vaultId,
  hosts,
  resolveAuthSecret,
  presentation = 'panel',
}: WorkspaceFileSystemAppProps) {
  const { t, locale } = useT()
  const c = workspaceFilesCopy[locale]
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
  const [recent, setRecent] = useState<{ scope: string | null; paths: string[] }>({ scope: null, paths: [] })
  const [editorBaseline, setEditorBaseline] = useState('')
  const [cursorLine, setCursorLine] = useState(1)
  const gutterRef = useRef<HTMLDivElement>(null)
  const homeErrorMessage = t('workspace.fileSystem.error.home')
  const directoryErrorMessage = t('workspace.fileSystem.error.directory')

  function navigateToPath(path: string, sidebarLocationId?: string) {
    setActiveSidebarLocationId(sidebarLocationId ?? null)
    if (path === currentPath) return
    const scope = activeHost?.id ?? null
    setRecent((prev) => ({ scope, paths: [path, ...(prev.scope === scope ? prev.paths : []).filter((entry) => entry !== path)].slice(0, MAX_RECENT_PATHS) }))
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
      const content = decodeBase64Utf8(fileData.contentB64)
      setEditorPath(entry.path)
      setEditorContent(content)
      setEditorBaseline(content)
      setCursorLine(1)
      setSelectedPath(entry.path)
    } finally {
      setIsOpeningFile(false)
    }
  }

  async function handleSaveFile() {
    if (!remoteFs || !editorPath || isMutating) return
    setIsSaving(true)
    setStatusMessage(null)
    const savedContent = editorContent
    try {
      await performMutation(async () => {
        if (await remoteFs.writeFile(editorPath, encodeBase64Utf8(savedContent)) === false) return false
        setEditorBaseline(savedContent)
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
  const isMobile = presentation === 'mobile'
  const isEditing = editorPath != null
  const isDirty = isEditing && editorContent !== editorBaseline
  const editorLineCount = editorContent.split('\n').length
  const editorFileName = editorPath?.split('/').pop() ?? ''
  const EditorIcon = getFileIcon({ path: editorPath ?? '', fileName: editorFileName, isDir: false })
  const sidebarPaths = new Set(sidebarLocations.map((loc) => loc.path))
  const recentPaths = (recent.scope === activeHost.id ? recent.paths : []).filter((path) => !sidebarPaths.has(path))
  const selectedModifiedAt = selectedEntry ? formatModifiedAt(selectedEntry.modifiedAt, locale) : null
  const SelectedIcon = selectedEntry ? getFileIcon(selectedEntry) : File

  const canPreviewSelected = !!selectedEntry && !selectedEntry.isDir && /\.(md|markdown|html?)$/i.test(selectedEntry.fileName)
  const folderSummary = t(folderCount === 1 ? 'workspace.fileSystem.count.folderOne' : 'workspace.fileSystem.count.folderMany', { count: folderCount })
  const fileSummary = t(fileCount === 1 ? 'workspace.fileSystem.count.fileOne' : 'workspace.fileSystem.count.fileMany', { count: fileCount })

  const iconBtn = cn(
    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workspace-border-glow)]',
    'disabled:pointer-events-none disabled:opacity-40',
    'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]',
  )
  const quietBtn = cn(
    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workspace-border-glow)]',
    'disabled:pointer-events-none disabled:opacity-45',
    'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]',
  )
  const primaryBtn = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50'
  const secondaryBtn = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-45'
  const navItem = (isActive: boolean) => cn(
    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
    isActive
      ? 'bg-[var(--workspace-surface-700)] font-medium text-[var(--workspace-text-strong)] shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]'
      : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
  )
  const statusBar = (left: string) => (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--workspace-border-soft)] px-4 py-2 text-[11px] text-[var(--workspace-text-subtle)]">
      <span className="truncate">{left}</span>
      <span className="truncate">{activeHost.name} · {activeHost.address}</span>
    </div>
  )

  return (
    <div
      data-testid="workspace-file-system-app"
      className={cn('flex min-h-0 flex-col gap-4 text-[var(--workspace-text)]', isEmbedded ? 'h-full' : 'min-h-[36rem]')}
    >
      <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h2>
          <p className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">
            {isEditing ? fill(c.editSubtitle, { path: editorPath }) : c.subtitle}
          </p>
        </div>
        {isEditing && (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className={secondaryBtn} onClick={() => { setEditorPath(null); setEditorContent(''); setEditorBaseline('') }} disabled={isSaving}>
              <X className="h-3.5 w-3.5" />
              {c.cancel}
            </button>
            <button type="button" className={primaryBtn} onClick={() => void handleSaveFile()} disabled={isSaving || isMutating}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? t('workspace.fileSystem.saving') : t('workspace.fileSystem.saveFile')}
            </button>
          </div>
        )}
      </header>

      <div
        className={cn(
          'grid min-h-0 flex-1 gap-3',
          !isMobile && (isEditing ? 'lg:grid-cols-[10.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[10.5rem_minmax(0,1fr)_15rem]'),
        )}
      >
        <aside className="min-w-0 overflow-auto">
          <div className="mb-1.5 px-2.5 text-xs font-medium text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.locations')}</div>
          <div className="space-y-0.5">
            {sidebarLocations.map((loc) => {
              const isActive = currentPath === loc.path
                && (activeSidebarLocationId == null || activeSidebarLocationId === loc.id)
              return (
                <button key={loc.id} type="button" onClick={() => navigateToPath(loc.path, loc.id)} className={navItem(isActive)}>
                  <SidebarLocationIcon id={loc.id} />
                  <span className="truncate">{loc.label}</span>
                </button>
              )
            })}
          </div>
          {recentPaths.length > 0 && (
            <>
              <div className="mb-1.5 mt-4 px-2.5 text-xs font-medium text-[var(--workspace-text-subtle)]">{c.recent}</div>
              <div className="space-y-0.5">
                {recentPaths.map((path) => {
                  const id = `recent:${path}`
                  const isActive = currentPath === path && (activeSidebarLocationId == null || activeSidebarLocationId === id)
                  return (
                    <button key={id} type="button" title={path} onClick={() => navigateToPath(path, id)} className={navItem(isActive)}>
                      <Folder className="h-4 w-4 shrink-0" />
                      <span className="truncate">{path}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
          <div className="mt-4 rounded-lg bg-[var(--workspace-surface-800)] px-2.5 py-2.5 text-[11px] leading-5 text-[var(--workspace-text-muted)]">
            <Info className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
            {c.sftpHintBefore}
            {sessionId ? (
              <button type="button" onClick={() => sessions.setSessionWorkspaceApp(sessionId, 'fileTransfer')} className="text-[var(--workspace-accent-text)] hover:underline">
                {c.sftpHintLink}
              </button>
            ) : <span className="text-[var(--workspace-text)]">{c.sftpHintLink}</span>}
            {c.sftpHintAfter}
          </div>
        </aside>

        {isEditing ? (
          <section className="sb-card flex min-h-[24rem] min-w-0 flex-col overflow-hidden bg-[var(--workspace-surface-900)]">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <EditorIcon className="h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />
                <h3 className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{editorFileName}</h3>
                {isDirty && (
                  <span className="shrink-0 rounded-md bg-[var(--workspace-status-warn-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--workspace-status-warn-text)]">{c.unsaved}</span>
                )}
              </div>
              <span className="hidden truncate text-[11px] text-[var(--workspace-text-subtle)] sm:block">{c.saveNote}</span>
            </div>
            {statusMessage && (
              <div className="mx-4 mt-3 rounded-lg border border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-good-text)]">{statusMessage}</div>
            )}
            {error && (
              <div className="mx-4 mt-3 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{error}</div>
            )}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div
                ref={gutterRef}
                aria-hidden="true"
                className="shrink-0 overflow-hidden whitespace-pre border-r border-[color:var(--workspace-border-soft)] px-3 py-3 text-right font-mono text-xs leading-5 text-[var(--workspace-text-subtle)]"
              >
                {Array.from({ length: editorLineCount }, (_, index) => index + 1).join('\n')}
              </div>
              <textarea
                aria-label={t('workspace.fileSystem.editorLabel')}
                value={editorContent}
                spellCheck={false}
                wrap="off"
                onChange={(e) => {
                  setEditorContent(e.target.value)
                  setCursorLine(e.target.value.slice(0, e.target.selectionStart).split('\n').length)
                }}
                onSelect={(e) => setCursorLine(e.currentTarget.value.slice(0, e.currentTarget.selectionStart).split('\n').length)}
                onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop }}
                className="min-h-0 min-w-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-5 text-[var(--workspace-text)] outline-none"
              />
            </div>
            {statusBar(fill(c.cursor, { line: cursorLine, eol: editorContent.includes('\r\n') ? 'CRLF' : 'LF' }))}
          </section>
        ) : (
          <>
            <section className="sb-card flex min-h-[24rem] min-w-0 flex-col overflow-hidden bg-[var(--workspace-surface-900)]">
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <button
                    type="button"
                    title={t('workspace.fileSystem.action.goUp')}
                    aria-label={t('workspace.fileSystem.action.goUp')}
                    disabled={!canGoUp || isLoading}
                    onClick={() => currentPath && navigateToPath(parentRemotePath(currentPath))}
                    className={iconBtn}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title={t('workspace.fileSystem.action.refresh')}
                    aria-label={t('workspace.fileSystem.action.refresh')}
                    disabled={!currentPath || isLoading}
                    onClick={() => void refreshCurrentPath()}
                    className={iconBtn}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                  <div className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => navigateToPath('/')}
                      className="shrink-0 rounded px-1 py-0.5 text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]"
                    >
                      /
                    </button>
                    {breadcrumbs.map((seg, i) => (
                      <span key={seg.path} className="flex min-w-0 items-center gap-0.5">
                        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" />
                        <button
                          type="button"
                          onClick={() => navigateToPath(seg.path)}
                          className={cn(
                            'truncate rounded px-1 py-0.5 transition-colors',
                            i === breadcrumbs.length - 1
                              ? 'text-[var(--workspace-text-strong)]'
                              : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                          )}
                        >
                          {seg.label}
                        </button>
                      </span>
                    ))}
                    {currentPath == null && (
                      <span className="font-sans text-[var(--workspace-text-muted)]">{t('workspace.fileSystem.loading')}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-0.5">
                  <button type="button" title={t('workspace.fileSystem.action.newFile')} aria-label={t('workspace.fileSystem.action.newFile')} disabled={!currentPath || isMutating} onClick={() => void handleCreateFile()} className={quietBtn}>
                    <FilePlus className="h-3.5 w-3.5" />
                    {t('workspace.fileSystem.action.newFile')}
                  </button>
                  <button type="button" title={t('workspace.fileSystem.action.newFolder')} aria-label={t('workspace.fileSystem.action.newFolder')} disabled={!currentPath || isMutating} onClick={() => void handleCreateDir()} className={quietBtn}>
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t('workspace.fileSystem.action.newFolder')}
                  </button>
                  <button type="button" title={t('workspace.fileSystem.action.rename')} aria-label={t('workspace.fileSystem.action.rename')} disabled={!selectedEntry || isMutating} onClick={() => void handleRenameSelected()} className={quietBtn}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('workspace.fileSystem.action.rename')}
                  </button>
                  <button
                    type="button"
                    title={t('workspace.fileSystem.action.delete')}
                    aria-label={t('workspace.fileSystem.action.delete')}
                    disabled={!selectedEntry || isMutating}
                    onClick={() => void handleDeleteSelected()}
                    className={cn(quietBtn, 'hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('workspace.fileSystem.action.delete')}
                  </button>
                  <button
                    type="button"
                    title={t('workspace.fileSystem.action.preview')}
                    aria-label={t('workspace.fileSystem.action.preview')}
                    disabled={!canPreviewSelected}
                    onClick={() => selectedEntry && void handlePreviewFile(selectedEntry)}
                    className={quietBtn}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t('workspace.fileSystem.action.preview')}
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_6rem_7rem] border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 text-xs font-medium text-[var(--workspace-text-subtle)]">
                  <div>{t('workspace.fileSystem.column.name')}</div>
                  <div>{t('workspace.fileSystem.column.size')}</div>
                  <div>{t('workspace.fileSystem.column.kind')}</div>
                </div>

                {statusMessage && (
                  <div className="mx-3 mt-3 rounded-lg border border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-good-text)]">
                    {statusMessage}
                  </div>
                )}
                {error && (
                  <div className="mx-3 mt-3 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">
                    {error}
                  </div>
                )}
                {isLoading && (
                  <div className="px-3 py-6 text-sm text-[var(--workspace-text-muted)]">
                    {isLoadingHome ? t('workspace.fileSystem.loadingHome') : t('workspace.fileSystem.loadingDirectory')}
                  </div>
                )}

                {!isLoading && !error && (
                  entries.length > 0 ? (
                    <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                      {entries.map((entry) => {
                        const isSelected = selectedPath === entry.path
                        const EntryIcon = getFileIcon(entry)
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
                              'grid w-full grid-cols-[minmax(0,1fr)_6rem_7rem] items-center px-3 py-1.5 text-left text-[13px] transition-colors',
                              isSelected
                                ? 'bg-[var(--workspace-surface-row-selected)] text-[var(--workspace-text-strong)] shadow-[inset_3px_0_0_hsl(var(--primary))]'
                                : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <EntryIcon className={cn('h-4 w-4 shrink-0', entry.isDir ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-subtle)]')} />
                              <span className="truncate">{entry.fileName}</span>
                            </div>
                            <div className="font-mono text-xs text-[var(--workspace-text-muted)]">
                              {entry.isDir ? '—' : formatFileSize(entry.size)}
                            </div>
                            <div className="truncate text-xs text-[var(--workspace-text-muted)]">
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
              </div>

              {statusBar(isLoading ? t('workspace.fileSystem.loading') : t('workspace.fileSystem.statusSummary', { folders: folderSummary, files: fileSummary }))}
            </section>

            <aside className="sb-card min-w-0 overflow-auto bg-[var(--workspace-surface-900)] p-4">
              {selectedEntry ? (
                <div className="flex flex-col gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--workspace-surface-800)]">
                    <SelectedIcon className={cn('h-6 w-6', selectedEntry.isDir ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text)]')} />
                  </div>
                  <h3 className="truncate text-base font-semibold text-[var(--workspace-text-strong)]" title={selectedEntry.fileName}>{selectedEntry.fileName}</h3>
                  <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                    <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.column.kind')}</dt>
                    <dd className="text-[var(--workspace-text-strong)]">{selectedEntry.isDir ? t('workspace.fileSystem.kind.folder') : getFileKind(selectedEntry.fileName, t)}</dd>
                    {!selectedEntry.isDir && (
                      <>
                        <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.column.size')}</dt>
                        <dd className="font-mono text-[var(--workspace-text-strong)]">{formatFileSize(selectedEntry.size)}</dd>
                      </>
                    )}
                    <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.fileSystem.path')}</dt>
                    <dd className="break-all font-mono text-[var(--workspace-text-strong)]">{selectedEntry.path}</dd>
                    {selectedModifiedAt && (
                      <>
                        <dt className="text-[var(--workspace-text-subtle)]">{c.modified}</dt>
                        <dd className="font-mono text-[var(--workspace-text-strong)]">{selectedModifiedAt}</dd>
                      </>
                    )}
                  </dl>
                  {!selectedEntry.isDir && (
                    <>
                      <button type="button" className={cn(primaryBtn, 'mt-1 w-full')} disabled={isOpeningFile} onClick={() => void handleOpenFile(selectedEntry)}>
                        <Pencil className="h-3.5 w-3.5" />
                        {isOpeningFile ? t('workspace.fileSystem.openingFile') : c.edit}
                      </button>
                      <button type="button" className={cn(secondaryBtn, 'w-full')} disabled={!canPreviewSelected} onClick={() => void handlePreviewFile(selectedEntry)}>
                        <Globe className="h-3.5 w-3.5" />
                        {t('workspace.fileSystem.previewInBrowser')}
                      </button>
                      {!canPreviewSelected && <p className="text-[11px] text-[var(--workspace-text-subtle)]">{c.previewOnly}</p>}
                    </>
                  )}
                </div>
              ) : (
                <div className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[color:var(--workspace-border-soft)] px-3 py-8 text-center text-xs text-[var(--workspace-text-subtle)]">
                  <span>{t('workspace.fileSystem.selectPrompt')}</span>
                  <span>{isOpeningFile ? t('workspace.fileSystem.openingFile') : t('workspace.fileSystem.doubleClickToEdit')}</span>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
