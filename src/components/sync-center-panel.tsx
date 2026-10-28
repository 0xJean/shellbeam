import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import {
  Monitor,
  Laptop,
  Loader2,
  RefreshCw,
  Radar,
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  ChevronRight,
  ShieldCheck,
  Check,
  Server,
  Code2,
  KeyRound,
  Pencil,
  Trash2,
} from 'lucide-react'
import { mdnsStartDiscover, mdnsStopDiscover, onMdnsDeviceFound, getAndroidDeviceName, type DiscoveredDevice } from '@/lib/mdns'
import { getSystemHostname, syncSendPairRequest, syncAcceptPair } from '@/lib/sync'
import { listen } from '@tauri-apps/api/event'
import type {
  SyncChangeRecord,
  SyncCursorRecord,
  SyncDeviceIdentity,
  SyncTrustedPeer,
  SyncDataOptions,
} from '@/lib/sync'
import { Button } from '@/components/ui/button'
import { fill } from '@/lib/locales/probe-install'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { cn } from '@/lib/utils'
import { PairDialog, ScanningView, PairingView, ConfirmingView, IncomingPairView, ConnectFailedView, type PairStep } from './sync-pairing-views'
import { SyncPeerDetail } from './sync-peer-detail'
type SyncView = 'home' | 'scanning' | 'pairing' | 'confirming' | 'incoming' | 'peer-detail' | 'connect-failed'

interface SyncCenterPanelProps {
  localDevice: SyncDeviceIdentity | null
  changes: SyncChangeRecord[]
  cursors: SyncCursorRecord[]
  trustedPeers: SyncTrustedPeer[]
  loading: boolean
  serverRunning: boolean
  serverPort: number
  onRefresh: () => Promise<void>
  onInitDevice: (deviceName?: string) => Promise<void>
  onStartServer: (port?: number) => Promise<void>
  onPullFromPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onPushToPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onRemoveTrustedPeer: (peerDeviceId: string) => Promise<void>
  /** Name of the active vault that pull/push sync. */
  syncVaultName?: string
  /** Rendered beside device sync as the merged v3 "Sync & backup" page. */
  backupPanel?: ReactNode
  /** 'backup' scrolls the backup column into view (legacy `backup` nav id). */
  focusSection?: 'sync' | 'backup'
}

export function SyncCenterPanel({
  localDevice, changes, trustedPeers,
  loading, serverRunning, serverPort,
  onRefresh, onInitDevice, onStartServer,
  onPullFromPeer, onPushToPeer, onRemoveTrustedPeer, syncVaultName,
  backupPanel, focusSection = 'sync',
}: SyncCenterPanelProps) {
  const { t, locale } = useT()
  const copy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const [view, setView] = useState<SyncView>('home')
  const [activePeer, setActivePeer] = useState<SyncTrustedPeer | null>(null)
  const [showAllChanges, setShowAllChanges] = useState(false)
  const [seenFocus, setSeenFocus] = useState(focusSection)
  const backupRef = useRef<HTMLDivElement>(null)
  if (seenFocus !== focusSection) {
    setSeenFocus(focusSection)
    if (focusSection === 'backup' && view === 'peer-detail') {
      setActivePeer(null)
      setView('home')
    }
  }
  useEffect(() => {
    if (focusSection === 'backup') backupRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [focusSection])
  const [scanning, setScanning] = useState(false)
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [deviceName, setDeviceName] = useState('')

  const [incomingPairRequest, setIncomingPairRequest] = useState<{
    sessionId: string
    peerDeviceId: string
    peerDeviceName: string
    peerHost: string
    verificationCode: string
  } | null>(null)
  const [generatedPin, setGeneratedPin] = useState('')
  const scanCleanupRef = useRef<(() => void) | null>(null)
  const [onlinePeerEndpoints, setOnlinePeerEndpoints] = useState<Set<string>>(new Set())
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeUnlistenRef = useRef<(() => void) | null>(null)

  const needsInit = !localDevice
  const [localHostname, setLocalHostname] = useState('')

  useEffect(() => {
    void getSystemHostname().then((name) => {
      // On Android, prefer the real device model name from NSD bridge
      const androidName = getAndroidDeviceName()
      const effectiveName = androidName || name
      // Avoid using known-bad fallback names
      const badNames = ['localhost', 'shellbeam-android']
      const safeName = (effectiveName && !badNames.includes(effectiveName.toLowerCase()))
        ? effectiveName
        : (androidName || '')
      if (safeName) {
        setLocalHostname(safeName)
        if (needsInit) setDeviceName(safeName)
      } else if (effectiveName) {
        setLocalHostname(effectiveName)
        if (needsInit) setDeviceName(effectiveName)
      }
    })
  }, [needsInit])

  // Background probe: auto-discover devices and cross-reference with trusted peers.
  const scanActiveRef = useRef(false)

  const stopProbe = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
    }
    probeUnlistenRef.current?.()
    probeUnlistenRef.current = null
    if (!scanActiveRef.current) { void mdnsStopDiscover() }
  }, [])

  const probePeersOnline = useCallback(() => {
    if (!serverRunning || needsInit || scanActiveRef.current) return
    stopProbe()

    const unlistenEvent = onMdnsDeviceFound((device) => {
      const ep = `${device.host}:${device.port}`
      setOnlinePeerEndpoints((prev) => {
        if (prev.has(ep)) return prev
        const next = new Set(prev)
        next.add(ep)
        return next
      })
    })
    probeUnlistenRef.current = unlistenEvent

    void mdnsStartDiscover().catch(() => {})
    probeTimerRef.current = setTimeout(() => {
      probeUnlistenRef.current?.()
      probeUnlistenRef.current = null
      probeTimerRef.current = null
      if (!scanActiveRef.current) { void mdnsStopDiscover() }
    }, 4000)
  }, [serverRunning, needsInit, stopProbe])

  // Run probe when panel mounts or server starts
  useEffect(() => {
    if (serverRunning && !needsInit && (view === 'home' || view === 'peer-detail')) {
      setOnlinePeerEndpoints(new Set())
      probePeersOnline()
    }
    return () => { stopProbe() }
  }, [serverRunning, needsInit, view, probePeersOnline, stopProbe])

  function isPeerOnline(peer: SyncTrustedPeer): boolean {
    if (!peer.peerEndpoint) return false
    return onlinePeerEndpoints.has(peer.peerEndpoint)
  }

  const startScan = useCallback(() => {
    scanCleanupRef.current?.()
    scanCleanupRef.current = null
    stopProbe()
    scanActiveRef.current = true
    setScanning(true)
    setDiscoveredDevices([])
    setSelectedDevice(null)
    setPairingError('')
    if (!serverRunning) { void onStartServer(9123) }

    setTimeout(() => {
      setView('scanning')
      const unlistenEvent = onMdnsDeviceFound((device) => {
        if (localHostname && device.name === localHostname) return
        setDiscoveredDevices((prev) => {
          if (prev.some((d) => d.name === device.name)) return prev
          return [...prev, device]
        })
      })
      void mdnsStartDiscover().catch(() => {})
      scanCleanupRef.current = () => {
        unlistenEvent()
        void mdnsStopDiscover()
        scanActiveRef.current = false
      }
    }, 200)
  }, [serverRunning, onStartServer, localHostname, stopProbe])

  function stopScan() {
    scanCleanupRef.current?.()
    scanCleanupRef.current = null
    setScanning(false)
    scanActiveRef.current = false
  }

  useEffect(() => {
    return () => {
      scanCleanupRef.current?.()
      scanCleanupRef.current = null
      scanActiveRef.current = false
    }
  }, [])

  async function handleSelectDeviceAndPair(device: DiscoveredDevice) {
    setSelectedDevice(device)
    stopScan()
    setView('pairing')
    setPairingBusy(true)
    setPairingError('')
    try {
      const session = await syncSendPairRequest({
        peerHost: device.host,
        peerPort: device.port,
        peerName: device.name,
      })
      setGeneratedPin(session.verificationCode)
      setView('confirming')
      await onRefresh()
    } catch (err) {
      const msg = String(err)
      // Connection timed out / refused → device blocks inbound TCP (Android)
      if (msg.includes('timed out') || msg.includes('refused') || msg.includes('Connect to')) {
        setView('connect-failed')
      } else {
        setPairingError(msg)
      }
    } finally {
      setPairingBusy(false)
    }
  }

  // Listen for incoming pair requests from remote devices
  useEffect(() => {
    let unlisten: (() => void) | null = null
    listen<{
      sessionId: string
      peerDeviceId: string
      peerDeviceName: string
      peerHost: string
      verificationCode: string
    }>('pair-request-received', (event) => {
      console.log('[sync] pair-request-received event:', JSON.stringify(event.payload))
      setIncomingPairRequest(event.payload)
      setView('incoming')
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  // Listen for pair-confirmed event (initiator gets this when receiver accepts)
  useEffect(() => {
    let unlisten: (() => void) | null = null
    listen<{ peerDeviceId: string; peerDeviceName: string }>('pair-confirmed', (event) => {
      console.log('[sync] pair-confirmed event:', JSON.stringify(event.payload))
      setGeneratedPin('')
      setSelectedDevice(null)
      void onRefresh().then(() => {
        // Auto-navigate to the newly paired peer's detail view
        const newPeerId = event.payload.peerDeviceId
        const newPeerName = event.payload.peerDeviceName
        if (newPeerId) {
          setActivePeer({ peerDeviceId: newPeerId, peerDeviceName: newPeerName } as SyncTrustedPeer)
          setView('peer-detail')
        } else {
          setView('home')
        }
      })
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [onRefresh])

  async function handleAcceptPair() {
    if (!incomingPairRequest) return
    setPairingBusy(true)
    setPairingError('')
    try {
      const peerHost = incomingPairRequest.peerHost
      if (!peerHost) {
        setPairingError('Cannot find peer device address')
        return
      }
      await syncAcceptPair({
        sessionId: incomingPairRequest.sessionId,
        peerHost,
        peerPort: 9123,
      })
      await onRefresh()
      const newPeerId = incomingPairRequest.peerDeviceId
      const newPeerName = incomingPairRequest.peerDeviceName
      setIncomingPairRequest(null)
      if (newPeerId) {
        setActivePeer({ peerDeviceId: newPeerId, peerDeviceName: newPeerName } as SyncTrustedPeer)
        setView('peer-detail')
      } else {
        setView('home')
      }
    } catch (err) {
      setPairingError(String(err))
    } finally {
      setPairingBusy(false)
    }
  }

  function handleCancel() {
    stopScan()
    setSelectedDevice(null)
    setPairingError('')
    setIncomingPairRequest(null)
    setGeneratedPin('')
    setView('home')
  }

  const pairBody = (() => {
    if (view === 'scanning') {
      return (
        <ScanningView
          scanning={scanning}
          discoveredDevices={discoveredDevices}
          selectedDevice={selectedDevice}
          serverPort={serverRunning ? serverPort : undefined}
          onSelectDevice={(d) => void handleSelectDeviceAndPair(d)}
          onRescan={startScan}
          onCancel={handleCancel}
        />
      )
    }
    if (view === 'pairing') {
      return (
        <PairingView
          selectedDeviceName={selectedDevice?.name ?? 'peer device'}
          pairingError={pairingError}
          onCancel={handleCancel}
        />
      )
    }
    if (view === 'confirming') {
      return (
        <ConfirmingView
          selectedDevice={selectedDevice}
          generatedPin={generatedPin}
          pairingError={pairingError}
          onCancel={handleCancel}
        />
      )
    }
    if (view === 'incoming' && incomingPairRequest) {
      return (
        <IncomingPairView
          request={incomingPairRequest}
          pairingBusy={pairingBusy}
          pairingError={pairingError}
          onAccept={() => void handleAcceptPair()}
          onCancel={handleCancel}
        />
      )
    }
    if (view === 'connect-failed' && selectedDevice) {
      return <ConnectFailedView device={selectedDevice} onCancel={handleCancel} onRescan={startScan} />
    }
    return null
  })()
  const pairStep: PairStep = view === 'scanning' ? 'scan' : view === 'incoming' ? 'incoming' : view === 'connect-failed' ? 'failed' : 'verify'

  const header = (subtitle: string, action?: ReactNode) => (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{copy.title}</h1>
        <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{subtitle}</p>
      </div>
      {action}
    </div>
  )

  // ── Peer detail view (push / pull / remove) ──────────────────────────────
  if (view === 'peer-detail' && activePeer) {
    const peer = trustedPeers.find((p) => p.peerDeviceId === activePeer.peerDeviceId) ?? activePeer
    const peerOnline = isPeerOnline(peer)
    const back = () => { setActivePeer(null); setView('home') }
    return (
      <div className="space-y-5">
        {header(copy.descDetail, (
          <button type="button" onClick={back} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
            <ArrowLeft className="h-4 w-4" />
            {t('sync.backToHome')}
          </button>
        ))}
        <SyncPeerDetail
          peer={peer}
          peerOnline={peerOnline}
          loading={loading}
          onBack={back}
          onScan={startScan}
          onPullFromPeer={onPullFromPeer}
          onPushToPeer={onPushToPeer}
          onRemoveTrustedPeer={onRemoveTrustedPeer}
          vaultName={syncVaultName}
        />
      </div>
    )
  }

  const visibleChanges = changes.slice(showAllChanges ? 0 : -5).reverse()
  const syncCard = needsInit ? (
    <section className="sb-card flex flex-col items-center gap-4 px-7 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
        <Laptop className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-[16px] font-semibold text-[var(--workspace-text-strong)]">{t('sync.initDevice')}</h2>
        <p className="mt-1 text-[12px] text-[var(--workspace-text-muted)]">{copy.initDesc}</p>
      </div>
      <div className="w-full max-w-sm space-y-1.5 text-left">
        <label htmlFor="sync-device-name" className="text-[12px] font-medium text-[var(--workspace-text-strong)]">{copy.deviceName}</label>
        <input
          id="sync-device-name"
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder={t('sync.deviceName')}
          className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] text-[var(--workspace-text-strong)] outline-none focus:border-[color:var(--workspace-primary-500)]"
        />
        {localHostname && deviceName === localHostname && <p className="text-[11px] text-[var(--workspace-text-subtle)]">{copy.prefilled}</p>}
        <Button className="mt-2 h-10 w-full" disabled={loading} onClick={() => void onInitDevice(deviceName.trim() || undefined)}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sync.initialize')}
        </Button>
      </div>
    </section>
  ) : (
    <section className="sb-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-5 py-3">
        <RefreshCw className="h-4 w-4 text-[var(--workspace-text-muted)]" />
        <h2 className="text-[14px] font-semibold text-[var(--workspace-text-strong)]">{copy.deviceSync}</h2>
        <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px]', serverRunning ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]')}>
          {serverRunning ? fill(copy.serverRunning, { port: serverPort }) : copy.serverStopped}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" aria-label={t('sync.refresh')} title={t('sync.refresh')} onClick={() => void onRefresh()} disabled={loading} className="h-8 w-8 p-0">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          <Button size="sm" className="gap-1.5" onClick={startScan} disabled={loading || scanning}>
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
            {scanning ? t('sync.scanning') : copy.scanNearby}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-[color:var(--workspace-border-soft)] px-5 py-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
          <Laptop className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-[var(--workspace-text-strong)]">{localDevice.deviceName}</p>
          <p className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.thisDeviceSub, { id: localDevice.deviceId })}</p>
        </div>
        <span className="shrink-0 rounded-md bg-[var(--workspace-accent-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--workspace-accent-text)]">{copy.thisDevice}</span>
      </div>

      <div className="flex items-center justify-between px-5 pb-1.5 pt-3 text-[11px] text-[var(--workspace-text-subtle)]">
        <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />{fill(copy.trusted, { n: trustedPeers.length })}</span>
      </div>
      {trustedPeers.length === 0 ? (
        <p className="border-b border-[color:var(--workspace-border-soft)] px-5 pb-4 pt-1 text-[12px] text-[var(--workspace-text-muted)]">{copy.noPeers}</p>
      ) : trustedPeers.map((peer) => {
        const online = isPeerOnline(peer)
        const name = peer.peerDeviceName ?? t('sync.unknown')
        return (
          <button
            type="button"
            key={peer.peerDeviceId}
            aria-label={fill(copy.openPeer, { name })}
            className="flex w-full items-center gap-3 border-t border-[color:var(--workspace-border-soft)] px-5 py-3 text-left transition-colors hover:bg-[var(--workspace-surface-800)]"
            onClick={() => { setActivePeer(peer); setView('peer-detail') }}
          >
            <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', online ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
              <Monitor className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[13px] font-medium text-[var(--workspace-text-strong)]">{name}</p>
                <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', online ? 'text-[color:var(--workspace-status-good-text)]' : 'text-[var(--workspace-text-subtle)]')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-[color:var(--workspace-status-good)]' : 'bg-[var(--workspace-text-subtle)]')} />
                  {online ? t('sync.online') : t('sync.offline')}
                </span>
              </div>
              <p className="truncate text-[11px] text-[var(--workspace-text-muted)]">
                {fill(copy.peerSub, { endpoint: peer.peerEndpoint ?? t('sync.noEndpoint'), time: new Date(peer.lastSeenAt).toLocaleDateString() })}
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
          </button>
        )
      })}

      <div className="space-y-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-4">
        <p className="text-[11px] text-[var(--workspace-text-subtle)]">{copy.syncContent}</p>
        <div className="flex flex-wrap gap-1.5">
          {[copy.chipHosts, copy.chipSnippets, copy.chipVault].map((label) => (
            <span key={label} className="inline-flex items-center gap-1 rounded-md bg-[var(--workspace-accent-subtle)] px-2 py-1 text-[11px] text-[color:var(--workspace-accent-text)]">
              <Check className="h-3 w-3" />{label}
            </span>
          ))}
          <span className="inline-flex items-center rounded-md border border-[color:var(--workspace-border-soft)] px-2 py-1 text-[11px] text-[var(--workspace-text-muted)]">{copy.chipHistory}</span>
        </div>
      </div>

      {changes.length > 0 && (
        <div className="border-t border-[color:var(--workspace-border-soft)] px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] text-[var(--workspace-text-subtle)]">{t('sync.recentChanges', { n: changes.length })}</p>
            {changes.length > 5 && (
              <button type="button" aria-expanded={showAllChanges} onClick={() => setShowAllChanges((v) => !v)} className="flex items-center gap-1 text-[11px] font-medium text-[color:var(--workspace-accent-text)]">
                {showAllChanges ? copy.showLess : copy.showAll}
                <ArrowRight className={cn('h-3 w-3', showAllChanges && '-rotate-90')} />
              </button>
            )}
          </div>
          <ul className="space-y-1">
            {visibleChanges.map((c) => {
              const Icon = changeIcon(c.objectType, c.deleted)
              return (
                <li key={c.changeId} className="flex items-center gap-3 py-1 text-[12px]">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
                  <span className="min-w-0 flex-1 truncate text-[var(--workspace-text)]">
                    {c.summary || `${c.objectType}/${c.objectId}`}
                    {c.deleted && <span className="ml-1 text-[color:var(--workspace-status-bad-text)]">· {copy.deleted}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--workspace-text-subtle)]">v{c.version} · {new Date(c.updatedAt).toLocaleString()}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )

  return (
    <div className="space-y-5">
      {header(needsInit ? copy.descInit : copy.desc)}
      <div className={cn('grid items-start gap-4', backupPanel != null && 'lg:grid-cols-2')}>
        {syncCard}
        {backupPanel != null && <div ref={backupRef} id="sync-backup-section" className="scroll-mt-6">{backupPanel}</div>}
      </div>
      <PairDialog open={pairBody != null} step={pairStep} onClose={handleCancel}>
        {pairBody}
      </PairDialog>
    </div>
  )
}

function changeIcon(objectType: string, deleted: boolean) {
  if (deleted) return Trash2
  const type = objectType.toLowerCase()
  if (type.includes('host')) return Server
  if (type.includes('snippet')) return Code2
  if (type.includes('vault') || type.includes('key')) return KeyRound
  if (type.includes('forward')) return ArrowLeftRight
  return Pencil
}
