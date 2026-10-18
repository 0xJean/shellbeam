import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  ArrowRight,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  RefreshCw,
  HardDrive,
  Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { cn } from '@/lib/utils'
import type { HostProfile } from '@/lib/hosts'
import type { SftpEntry } from '@/lib/sftp'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import {
  localListDir,
  localHomeDir,
  localReadFileB64,
  localWriteFileB64,
} from '@/lib/sftp'
import { createRemoteFsClient } from '@/lib/remote-fs'
import { FilePane, type UnifiedEntry } from './sftp-file-pane'
import { SftpConnectPlaceholder } from './sftp-connect-placeholder'
import { getHostInventoryResource, HostMetadataLine } from './host-display-meta'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'

const COMPACT_BREAKPOINT = 700

function useContainerWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(Infinity)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [ref])
  return width
}

interface SftpDualPaneProps {
  hosts: HostProfile[]
  selectedHostId: string | null
  vaultId?: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  className?: string
}

export function SftpDualPane({ hosts, selectedHostId, vaultId, resolveAuthSecret, className }: SftpDualPaneProps) {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(containerRef)
  const isCompact = containerWidth < COMPACT_BREAKPOINT
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  const [activeTab, setActiveTab] = useState<'local' | 'remote'>('local')

  const [localDir, setLocalDir] = useState('')
  const [localEntries, setLocalEntries] = useState<UnifiedEntry[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localFilter, setLocalFilter] = useState('')
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set())
  const localInitRef = useRef(false)

  const [remoteDir, setRemoteDir] = useState('/root')
  const [remoteEntries, setRemoteEntries] = useState<UnifiedEntry[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteFilter, setRemoteFilter] = useState('')
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set())
  const [remoteConnected, setRemoteConnected] = useState(false)

  const [transferring, setTransferring] = useState(false)
  const [transferStatus, setTransferStatus] = useState('')
  const [selectedRemoteHostId, setSelectedRemoteHostId] = useState<string | null>(selectedHostId)
  const autoConnectHostRef = useRef<string | null>(null)

  const remoteHost = hosts.find((h) => h.id === selectedRemoteHostId) ?? null
  const remoteFs = useMemo(
    () => (remoteHost ? createRemoteFsClient(remoteHost, resolveAuthSecret, { vaultId }) : null),
    [remoteHost, resolveAuthSecret, vaultId],
  )

  useEffect(() => {
    if (localInitRef.current) return
    localInitRef.current = true
    localHomeDir()
      .then((dir) => {
        setLocalDir(dir)
        return localListDir(dir)
      })
      .then((entries) => setLocalEntries(entries.map((e) => ({ ...e }))))
      .catch(() => setLocalDir('/'))
  }, [])

  useEffect(() => {
    if (selectedHostId) setSelectedRemoteHostId(selectedHostId)
  }, [selectedHostId])

  const loadLocalDir = useCallback(async (dir?: string) => {
    const target = dir ?? localDir
    if (!target) return
    setLocalLoading(true)
    setLocalSelected(new Set())
    try {
      const entries = await localListDir(target)
      setLocalEntries(entries.map((e) => ({ ...e })))
    } catch (err) {
      setTransferStatus(`Local error: ${err}`)
    } finally {
      setLocalLoading(false)
    }
  }, [localDir])

  const loadRemoteDir = useCallback(async (dir?: string) => {
    if (!remoteHost || !remoteFs) return
    const target = dir ?? remoteDir
    setRemoteLoading(true)
    setRemoteSelected(new Set())
    try {
      const entries = await remoteFs.listDir(target)
      setRemoteEntries(entries.map((e: SftpEntry) => ({
        path: e.path, fileName: e.fileName, isDir: e.isDir,
        size: e.size, modifiedAt: e.modifiedAt,
      })))
      setRemoteConnected(true)
    } catch (err) {
      setTransferStatus(`Remote error: ${err}`)
    } finally {
      setRemoteLoading(false)
    }
  }, [remoteHost, remoteDir, remoteFs])

  useEffect(() => {
    if (!selectedRemoteHostId || !remoteHost || remoteConnected || remoteLoading) return
    if (autoConnectHostRef.current === selectedRemoteHostId) return

    autoConnectHostRef.current = selectedRemoteHostId
    setRemoteLoading(true)
    requestAnimationFrame(() => {
      void loadRemoteDir()
    })
  }, [selectedRemoteHostId, remoteHost, remoteConnected, remoteLoading, loadRemoteDir])

  function handleConnectRemote() {
    if (!remoteHost) return
    setRemoteLoading(true)
    requestAnimationFrame(() => {
      void loadRemoteDir()
    })
  }

  async function transferToRemote() {
    if (!remoteFs || localSelected.size === 0 || transferring) return
    setTransferring(true)
    setTransferStatus('')
    let done = 0
    try {
      const files = [...localSelected].flatMap((localPath) => {
        const entry = localEntries.find((e) => e.path === localPath)
        if (!entry || entry.isDir) return []
        const targetPath = remoteDir.endsWith('/') ? `${remoteDir}${entry.fileName}` : `${remoteDir}/${entry.fileName}`
        return [{ remotePath: targetPath, readContent: async () => {
          setTransferStatus(`Uploading ${entry.fileName}... (${++done}/${localSelected.size})`)
          return localReadFileB64(localPath)
        } }]
      })
      if (!await remoteFs.uploadFiles(files)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`Uploaded ${done} file(s)`)
      await loadRemoteDir()
    } catch (err) {
      setTransferStatus(`Upload error: ${err}`)
    } finally {
      setTransferring(false)
    }
  }

  async function transferToLocal() {
    if (!remoteFs || remoteSelected.size === 0) return
    setTransferring(true)
    setTransferStatus('')
    let done = 0
    try {
      for (const remotePath of remoteSelected) {
        const entry = remoteEntries.find((e) => e.path === remotePath)
        if (!entry || entry.isDir) continue
        setTransferStatus(`Downloading ${entry.fileName}... (${done + 1}/${remoteSelected.size})`)
        const data = await remoteFs.readFile(remotePath)
        const targetPath = localDir.endsWith('/') ? `${localDir}${entry.fileName}` : `${localDir}/${entry.fileName}`
        await localWriteFileB64(targetPath, data.contentB64)
        done++
      }
      setTransferStatus(`Downloaded ${done} file(s)`)
      await loadLocalDir()
    } catch (err) {
      setTransferStatus(`Download error: ${err}`)
    } finally {
      setTransferring(false)
    }
  }

  function localGoUp() {
    const parts = localDir.replace(/\/$/, '').split('/')
    if (parts.length > 1) {
      parts.pop()
      const next = parts.join('/') || '/'
      setLocalDir(next)
      void loadLocalDir(next)
    }
  }

  function remoteGoUp() {
    const parts = remoteDir.replace(/\/$/, '').split('/')
    if (parts.length > 1) {
      parts.pop()
      const next = parts.join('/') || '/'
      setRemoteDir(next)
      void loadRemoteDir(next)
    }
  }

  function handleLocalEnter(path: string) {
    setLocalDir(path)
    void loadLocalDir(path)
  }

  function handleRemoteEnter(path: string) {
    setRemoteDir(path)
    void loadRemoteDir(path)
  }

  async function handleRemoteDelete(paths: string[]) {
    if (!remoteFs || transferring) return
    setTransferring(true)
    try {
      if (!await remoteFs.deletePaths(paths)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`Deleted ${paths.length} item(s)`)
      await loadRemoteDir()
    } catch (err) { setTransferStatus(`Delete error: ${err}`) }
    finally { setTransferring(false) }
  }

  async function handleRemoteRename(oldPath: string, newName: string) {
    if (!remoteFs || transferring) return
    setTransferring(true)
    const dir = oldPath.substring(0, oldPath.lastIndexOf('/') + 1)
    try {
      if (!await remoteFs.renamePath(oldPath, `${dir}${newName}`)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`Renamed to: ${newName}`)
      await loadRemoteDir()
    } catch (err) { setTransferStatus(`Rename error: ${err}`) }
    finally { setTransferring(false) }
  }

  async function handleRemoteCreateDir(name: string) {
    if (!remoteFs || transferring) return
    setTransferring(true)
    const path = remoteDir.endsWith('/') ? `${remoteDir}${name}` : `${remoteDir}/${name}`
    try {
      if (!await remoteFs.createDir(path)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`Created folder: ${name}`)
      await loadRemoteDir()
    } catch (err) { setTransferStatus(`Create dir error: ${err}`) }
    finally { setTransferring(false) }
  }

  async function handleRemoteChmod(path: string, mode: number) {
    if (!remoteFs || transferring) return
    setTransferring(true)
    try {
      if (!await remoteFs.chmod(path, mode)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`chmod ${mode.toString(8)} → ${path.split('/').pop()}`)
      await loadRemoteDir()
    } catch (err) { setTransferStatus(`chmod error: ${err}`) }
    finally { setTransferring(false) }
  }

  async function handleDropUpload(files: FileList) {
    if (!remoteFs || !remoteConnected || files.length === 0 || transferring) return
    setTransferring(true)
    setTransferStatus('')
    let done = 0
    try {
      const uploads = Array.from(files).map((file) => {
        const targetPath = remoteDir.endsWith('/') ? `${remoteDir}${file.name}` : `${remoteDir}/${file.name}`
        return { remotePath: targetPath, readContent: async () => {
          setTransferStatus(`Uploading ${file.name}... (${++done}/${files.length})`)
          const bytes = new Uint8Array(await file.arrayBuffer())
          let binary = ''
          for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j])
          return btoa(binary)
        } }
      })
      if (!await remoteFs.uploadFiles(uploads)) { setTransferStatus(t('files.operation.cancelled')); return }
      setTransferStatus(`Uploaded ${done} file(s) via drag & drop`)
      await loadRemoteDir()
    } catch (err) { setTransferStatus(`Upload error: ${err}`) }
    finally { setTransferring(false) }
  }

  const remotePlaceholder = !remoteConnected ? (
    <SftpConnectPlaceholder
      loading={remoteLoading}
      hostName={remoteHost?.name ?? ''}
      hostAddress={remoteHost?.address ?? ''}
      hostPort={remoteHost?.port || 22}
      hasHost={!!remoteHost}
      onConnect={handleConnectRemote}
    />
  ) : null

  const localPaneEl = (
    <FilePane
      title="Local"
      icon={<HardDrive className="h-3.5 w-3.5 text-blue-500" />}
      entries={localEntries}
      currentDir={localDir}
      loading={localLoading}
      selectedPaths={localSelected}
      onDirChange={setLocalDir}
      onRefresh={() => void loadLocalDir()}
      onGoUp={localGoUp}
      onEnterDir={handleLocalEnter}
      onToggleSelect={(p) => setLocalSelected((prev) => {
        const next = new Set(prev)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        return next
      })}
      onSelectAll={() => setLocalSelected(new Set(localEntries.map((e) => e.path)))}
      onClearSelection={() => setLocalSelected(new Set())}
      filter={localFilter}
      onFilterChange={setLocalFilter}
    />
  )

  const remoteResource = getHostInventoryResource(remoteHost, inventoryStates)
  const remotePaneEl = (
    <FilePane
      title={remoteHost ? `${remoteHost.name} (${remoteHost.address})` : 'Remote'}
      icon={remoteHost && remoteResource?.os
        ? <WorkspaceOsIcon os={remoteResource.os} className="h-3.5 w-3.5 text-emerald-500" />
        : <Server className="h-3.5 w-3.5 text-emerald-500" />}
      entries={remoteEntries}
      currentDir={remoteDir}
      loading={remoteLoading}
      selectedPaths={remoteSelected}
      onDirChange={setRemoteDir}
      onRefresh={() => void loadRemoteDir()}
      onGoUp={remoteGoUp}
      onEnterDir={handleRemoteEnter}
      onToggleSelect={(p) => setRemoteSelected((prev) => {
        const next = new Set(prev)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        return next
      })}
      onSelectAll={() => setRemoteSelected(new Set(remoteEntries.map((e) => e.path)))}
      onClearSelection={() => setRemoteSelected(new Set())}
      filter={remoteFilter}
      onFilterChange={setRemoteFilter}
      placeholder={remotePlaceholder}
      mutationsDisabled={transferring}
      onDeletePaths={remoteConnected ? (paths) => void handleRemoteDelete(paths) : undefined}
      onRename={remoteConnected ? (o, n) => void handleRemoteRename(o, n) : undefined}
      onCreateDir={remoteConnected ? (n) => void handleRemoteCreateDir(n) : undefined}
      onChmod={remoteConnected ? (p, m) => void handleRemoteChmod(p, m) : undefined}
      onDropFiles={remoteConnected ? (f) => void handleDropUpload(f) : undefined}
    />
  )

  return (
    <div ref={containerRef} className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* Header toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <span className="shrink-0 text-sm font-semibold">{t('sftp.title')}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">{t('sftp.remote')}</span>
          <Select
            value={selectedRemoteHostId ?? ''}
            onChange={(v) => {
              const id = v || null
              setSelectedRemoteHostId(id)
              autoConnectHostRef.current = null
              setRemoteConnected(false)
              setRemoteEntries([])
            }}
            placeholder={t('sftp.selectHost')}
            className="h-7 max-w-[200px] text-xs [&_button]:h-7 [&_button]:text-xs"
            options={[
              { value: '', label: t('sftp.selectHost') },
              ...hosts.map((h) => ({
                value: h.id,
                label: `${h.name} (${h.address})`,
                icon: (
                  <HostMetadataLine
                    network={networkByAddress[h.address]}
                    resource={getHostInventoryResource(h, inventoryStates)}
                    showLocationText={false}
                    showSystemText={false}
                    className="gap-x-1"
                    iconClassName="h-3 w-3"
                  />
                ),
                description: (
                  <HostMetadataLine
                    network={networkByAddress[h.address]}
                    resource={getHostInventoryResource(h, inventoryStates)}
                    className="flex-nowrap"
                    itemClassName="max-w-[7rem]"
                    iconClassName="h-3 w-3"
                  />
                ),
              })),
            ]}
          />
        </div>
      </div>

      {/* Compact mode: tab switcher */}
      {isCompact && (
        <div className="flex shrink-0 border-b">
          <button
            type="button"
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'local' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab('local')}
          >
            <HardDrive className="h-3.5 w-3.5" />
            {t('sftp.local')}
          </button>
          <button
            type="button"
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'remote' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab('remote')}
          >
            <Server className="h-3.5 w-3.5" />
            {t('sftp.remoteTab')}
          </button>
        </div>
      )}

      {/* Main content area */}
      <div className="min-h-0 flex-1">
        {isCompact ? (
          /* Compact: single pane with transfer bar */
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col p-2">
              {activeTab === 'local' ? localPaneEl : remotePaneEl}
            </div>
            <div className="flex shrink-0 items-center justify-center gap-2 border-t px-3 py-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs"
                disabled={transferring || localSelected.size === 0 || !remoteHost || !remoteConnected}
                onClick={() => void transferToRemote()}
              >
                <ArrowUp className="h-3.5 w-3.5" />
                {t('sftp.upload', { n: localSelected.size })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs"
                disabled={transferring || remoteSelected.size === 0 || !remoteHost || !remoteConnected}
                onClick={() => void transferToLocal()}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                {t('sftp.download', { n: remoteSelected.size })}
              </Button>
            </div>
          </div>
        ) : (
          /* Wide: side-by-side dual pane */
          <div className="flex h-full min-h-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
              {localPaneEl}
            </div>
            <div className="flex w-14 shrink-0 flex-col items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0"
                disabled={transferring || localSelected.size === 0 || !remoteHost || !remoteConnected}
                onClick={() => void transferToRemote()}
                title={t('sftp.uploadToRemote')}
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0"
                disabled={transferring || remoteSelected.size === 0 || !remoteHost || !remoteConnected}
                onClick={() => void transferToLocal()}
                title={t('sftp.downloadToLocal')}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
              {remotePaneEl}
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      {transferStatus && (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5">
          {transferring && <RefreshCw className="h-3 w-3 animate-spin text-primary" />}
          <span className="truncate text-xs text-muted-foreground">{transferStatus}</span>
        </div>
      )}
    </div>
  )
}
