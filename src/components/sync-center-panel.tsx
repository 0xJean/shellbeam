import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Monitor,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  RefreshCw,
  ArrowUpFromLine,
  Radio,
  Lock,
  ArrowLeft,
  Trash2,
  Server,
  Code2,
  KeyRound,
  Check,
} from 'lucide-react'
import { mdnsStartDiscover, mdnsStopDiscover, onMdnsDeviceFound, type DiscoveredDevice } from '@/lib/mdns'
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
import { cn } from '@/lib/utils'
import { ScanRadar, DeviceCard } from './sync-widgets'
type SyncView = 'home' | 'scanning' | 'pairing' | 'confirming' | 'incoming' | 'peer-detail'

const SYNC_DATA_ITEMS = [
  { key: 'includeHosts', label: 'backup.hosts', icon: Server },
  { key: 'includeSnippets', label: 'backup.snippetsData', icon: Code2 },
  { key: 'includeVault', label: 'backup.vaultData', icon: KeyRound },
] as const

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
  onPushToPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onRemoveTrustedPeer: (peerDeviceId: string) => Promise<void>
}

export function SyncCenterPanel({
  localDevice, changes, cursors: _cursors, trustedPeers,
  loading, serverRunning, serverPort,
  onRefresh, onInitDevice, onStartServer,
  onPushToPeer, onRemoveTrustedPeer,
}: SyncCenterPanelProps) {
  const { t } = useT()
  const [view, setView] = useState<SyncView>('home')
  const [activePeer, setActivePeer] = useState<SyncTrustedPeer | null>(null)
  const [syncResult, setSyncResult] = useState('')
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
  const [syncDataOpts, setSyncDataOpts] = useState<SyncDataOptions>({ includeHosts: true, includeSnippets: true, includeVault: false })
  const anySyncDataSelected = syncDataOpts.includeHosts || syncDataOpts.includeSnippets || syncDataOpts.includeVault

  const needsInit = !localDevice
  const [localHostname, setLocalHostname] = useState('')

  useEffect(() => {
    void getSystemHostname().then((name) => {
      if (name) {
        setLocalHostname(name)
        if (needsInit) setDeviceName(name)
      }
    })
  }, [needsInit])

  // Background probe: auto-discover devices and cross-reference with trusted peers.
  // Uses its own event listener but shares the backend mDNS daemon.
  // We track whether a user-initiated scan is active to avoid interference.
  const scanActiveRef = useRef(false)

  // Helper to fully stop a probe (timer + event listener + backend discover)
  const stopProbe = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
    }
    probeUnlistenRef.current?.()
    probeUnlistenRef.current = null
    // Also stop the backend browse unless a user scan is active
    if (!scanActiveRef.current) {
      void mdnsStopDiscover()
    }
  }, [])

  const probePeersOnline = useCallback(() => {
    if (!serverRunning || needsInit) return
    // Don't probe if user is actively scanning — would interfere
    if (scanActiveRef.current) return

    // Clean up any previous probe first
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
    // Stop after 4 seconds — enough to find local devices
    probeTimerRef.current = setTimeout(() => {
      probeUnlistenRef.current?.()
      probeUnlistenRef.current = null
      probeTimerRef.current = null
      // Only stop discover if no user scan is active
      if (!scanActiveRef.current) {
        void mdnsStopDiscover()
      }
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
    // Clean up any previous scan first
    scanCleanupRef.current?.()
    scanCleanupRef.current = null

    // Stop any active probe (timer + event listener) so it doesn't interfere
    stopProbe()

    scanActiveRef.current = true
    setScanning(true)
    setDiscoveredDevices([])
    setSelectedDevice(null)
    setPairingError('')

    if (!serverRunning) {
      void onStartServer(9123)
    }

    setTimeout(() => {
      setView('scanning')
      const unlistenEvent = onMdnsDeviceFound((device) => {
        // Filter out self device
        if (localHostname && device.name === localHostname) return
        setDiscoveredDevices((prev) => {
          // Deduplicate by device name — keep only the first occurrence
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
      setPairingError(String(err))
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
      setIncomingPairRequest(event.payload)
      setView('incoming')
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  // Listen for pair-confirmed event (initiator gets this when receiver accepts)
  useEffect(() => {
    let unlisten: (() => void) | null = null
    listen<{ peerDeviceId: string; peerDeviceName: string }>('pair-confirmed', (event) => {
      setGeneratedPin('')
      setSelectedDevice(null)
      void onRefresh().then(() => {
        // Auto-navigate to the newly paired peer's detail view
        const newPeerId = event.payload.peerDeviceId
        const newPeerName = event.payload.peerDeviceName
        if (newPeerId) {
          setActivePeer({ peerDeviceId: newPeerId, peerDeviceName: newPeerName } as SyncTrustedPeer)
          setSyncResult('')
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
      // Auto-navigate to the newly paired peer's detail view
      const newPeerId = incomingPairRequest.peerDeviceId
      const newPeerName = incomingPairRequest.peerDeviceName
      setIncomingPairRequest(null)
      if (newPeerId) {
        setActivePeer({ peerDeviceId: newPeerId, peerDeviceName: newPeerName } as SyncTrustedPeer)
        setSyncResult('')
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

  // ── Home view: device info + peers + data ───────────────────────────────
  if (view === 'home') {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('sync.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {serverRunning ? t('sync.serverRunning', { port: serverPort }) : t('sync.desc')}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={loading} className="shrink-0 gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? '' : t('sync.refresh')}
          </Button>
        </div>

        {/* Init device if needed */}
        {needsInit ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-dashed border-border py-12">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Monitor className="h-7 w-7" />
            </div>
            <div className="text-center">
              <p className="font-medium">{t('sync.initDevice')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('sync.initDesc')}</p>
            </div>
            <div className="flex w-full max-w-xs items-center gap-2 px-4">
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder={t('sync.deviceName')}
                className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              />
              <Button size="sm" disabled={loading} onClick={() => void onInitDevice(deviceName.trim() || undefined)}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sync.initialize')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Local device card */}
            <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Monitor className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{localDevice.deviceName}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{localDevice.deviceId}</p>
              </div>
              <div className="flex items-center gap-1 text-xs text-emerald-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {t('sync.online')}
              </div>
            </div>

            {/* Scan button */}
            <Button className="w-full gap-2" onClick={startScan} disabled={loading || scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
              {scanning ? t('sync.scanning') : t('sync.scanDevices')}
            </Button>

            {/* Trusted peers */}
            {trustedPeers.length > 0 && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck className="h-4 w-4 text-emerald-500" />
                  {t('sync.trustedPeers', { n: trustedPeers.length })}
                </h3>
                {trustedPeers.map((peer) => (
                  <button
                    type="button"
                    key={peer.peerDeviceId}
                    className="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/40"
                    onClick={() => { setActivePeer(peer); setSyncResult(''); setView('peer-detail') }}
                  >
                    <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', isPeerOnline(peer) ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground')}>
                      <Monitor className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{peer.peerDeviceName ?? t('sync.unknown')}</p>
                        {isPeerOnline(peer) ? (
                          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            {t('sync.online')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t('sync.offline')}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {peer.peerEndpoint ?? t('sync.noEndpoint')}
                        {' · '}
                        {new Date(peer.lastSeenAt).toLocaleDateString()}
                      </p>
                    </div>
                    <ArrowLeft className="h-4 w-4 rotate-180 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}

            {/* Recent changes (collapsed) */}
            {changes.length > 0 && (
              <details className="rounded-xl border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  {t('sync.recentChanges', { n: changes.length })}
                </summary>
                <div className="space-y-1 border-t px-4 py-2">
                  {changes.slice(-8).reverse().map((c) => (
                    <p key={c.changeId} className="truncate font-mono text-[11px] text-muted-foreground">
                      v{c.version} · {c.objectType}/{c.objectId} · {c.summary ?? ''}
                    </p>
                  ))}
                </div>
              </details>
            )}

          </>
        )}
      </div>
    )
  }

  // ── Scanning view ─────────────────────────────────────────────────────────
  if (view === 'scanning') {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-12">
        <ScanRadar scanning={scanning} />

        <div className="text-center">
          <h2 className="text-lg font-semibold">
            {scanning ? t('sync.scanningDevices') : t('sync.scanComplete')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('sync.scanHint')}
          </p>
        </div>

        {discoveredDevices.length > 0 && (
          <div className="w-full space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t('sync.devicesFound', { n: discoveredDevices.length })}
            </p>
            {discoveredDevices.map((d) => (
              <DeviceCard
                key={`${d.host}:${d.port}`}
                name={d.name}
                host={d.host}
                port={d.port}
                deviceType={d.deviceType}
                onClick={() => void handleSelectDeviceAndPair(d)}
                selected={selectedDevice?.host === d.host && selectedDevice?.port === d.port}
              />
            ))}
          </div>
        )}

        {!scanning && discoveredDevices.length === 0 && (
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{t('sync.noDevices')}</p>
            <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={startScan}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('sync.retry')}
            </Button>
          </div>
        )}

        <Button variant="ghost" onClick={handleCancel} className="text-muted-foreground">
          {t('sync.cancel')}
        </Button>
      </div>
    )
  }

  // ── Pairing / waiting ─────────────────────────────────────────────────────
  if (view === 'pairing') {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold">{t('sync.initiatingPairing')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('sync.pairingHandshake', { name: selectedDevice?.name ?? 'peer device' })}
          </p>
        </div>
        {pairingError && (
          <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
        )}
        <Button variant="ghost" onClick={handleCancel} className="text-muted-foreground">
          {t('sync.cancel')}
        </Button>
      </div>
    )
  }

  // ── Confirming (initiator side — shows PIN, waiting for peer to accept) ──
  if (view === 'confirming') {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
          <CheckCircle2 className="h-8 w-8" />
        </div>

        <div className="text-center">
          <h2 className="text-lg font-semibold">{t('sync.pairingRequestSent')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('sync.waitingForPeerAccept')}
          </p>
        </div>

        {selectedDevice && (
          <div className="flex w-full items-center gap-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Monitor className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{selectedDevice.name}</p>
              <p className="text-xs text-muted-foreground">{selectedDevice.host}:{selectedDevice.port}</p>
            </div>
          </div>
        )}

        {generatedPin && (
          <div className="w-full rounded-xl border-2 border-primary/30 bg-primary/5 p-6 text-center">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('sync.verificationCode')}
            </p>
            <p className="font-mono text-3xl font-bold tracking-[0.3em] text-primary">{generatedPin}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('sync.confirmCodeOnPeer')}
            </p>
          </div>
        )}

        {pairingError && (
          <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
        )}

        <button type="button" onClick={handleCancel} className="text-sm text-muted-foreground hover:text-foreground">
          {t('sync.cancel')}
        </button>

        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
          <Lock className="h-3 w-3" />
          {t('sync.e2eBadge')}
        </div>
      </div>
    )
  }

  // ── Incoming pair request (receiver side — shows PIN + accept/reject) ────
  if (view === 'incoming' && incomingPairRequest) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
          <Radio className="h-8 w-8" />
        </div>

        <div className="text-center">
          <h2 className="text-lg font-semibold">{t('sync.incomingPairRequest')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('sync.deviceWantsToPair')}
          </p>
        </div>

        <div className="flex w-full items-center gap-3 rounded-xl border bg-muted/30 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{incomingPairRequest.peerDeviceName}</p>
            <p className="font-mono text-xs text-muted-foreground">{incomingPairRequest.peerDeviceId.slice(0, 16)}...</p>
          </div>
        </div>

        <div className="w-full rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-6 text-center">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('sync.verificationCode')}
          </p>
          <p className="font-mono text-3xl font-bold tracking-[0.3em] text-amber-500">{incomingPairRequest.verificationCode}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('sync.confirmCodeMatches')}
          </p>
        </div>

        {pairingError && (
          <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
        )}

        <div className="flex w-full gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleCancel}
          >
            {t('sync.reject')}
          </Button>
          <Button
            className="flex-1 gap-2"
            disabled={pairingBusy}
            onClick={() => void handleAcceptPair()}
          >
            {pairingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {pairingBusy ? t('sync.confirming') : t('sync.acceptPair')}
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
          <Lock className="h-3 w-3" />
          {t('sync.e2eBadge')}
        </div>
      </div>
    )
  }

  // ── Peer detail view (push / pull / remove) ──────────────────────────────
  if (view === 'peer-detail' && activePeer) {
    const peer = trustedPeers.find((p) => p.peerDeviceId === activePeer.peerDeviceId) ?? activePeer
    const peerOnline = isPeerOnline(peer)
    return (
      <div className="mx-auto max-w-md space-y-6 p-6 pt-8">
        {/* Back button */}
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => { setActivePeer(null); setView('home') }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('sync.backToHome')}
        </button>

        {/* Peer info card */}
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
          <div className={cn('flex h-12 w-12 items-center justify-center rounded-lg', peerOnline ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground')}>
            <Monitor className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="font-medium">{peer.peerDeviceName ?? t('sync.unknown')}</p>
              {peerOnline ? (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {t('sync.online')}
                </span>
              ) : (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                  {t('sync.offline')}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {peer.peerEndpoint ?? t('sync.noEndpoint')}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t('sync.lastSeen')}: {new Date(peer.lastSeenAt).toLocaleString()}
            </p>
          </div>
        </div>

        {!peerOnline && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-4 py-3">
            <Radio className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('sync.peerOfflineHint')}
            </p>
          </div>
        )}

        {/* Data type selection */}
        <div className="space-y-2">
          <span className="text-sm font-medium">{t('sync.dataToSync')}</span>
          <div className="grid grid-cols-3 gap-2">
            {SYNC_DATA_ITEMS.map((item) => {
              const Icon = item.icon
              const checked = syncDataOpts[item.key as keyof typeof syncDataOpts]
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={loading}
                  onClick={() => setSyncDataOpts(prev => ({ ...prev, [item.key]: !prev[item.key as keyof typeof prev] }))}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-2.5 text-left transition-all',
                    checked
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
                    loading && 'opacity-50 pointer-events-none',
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="flex-1 text-xs font-medium">{t(item.label)}</span>
                  <div className={cn(
                    'h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors',
                    checked ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                  )}>
                    {checked && <Check className="h-2 w-2 text-white" />}
                  </div>
                </button>
              )
            })}
          </div>
          {syncDataOpts.includeVault && (
            <p className="text-[11px] text-amber-500">
              {t('sync.vaultSyncHint')}
            </p>
          )}
        </div>

        {/* Sync (push) button */}
        <Button
          className="w-full gap-2"
          size="lg"
          disabled={loading || !peer.peerEndpoint || !anySyncDataSelected}
          onClick={async () => {
            setSyncResult('')
            try {
              await onPushToPeer(peer.peerDeviceId, syncDataOpts)
              setSyncResult(t('sync.syncSuccess'))
            } catch (err) {
              setSyncResult(String(err))
            }
          }}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
          {t('sync.syncToPeer')}
        </Button>

        {/* Sync result feedback */}
        {syncResult && (
          <p className="rounded-lg bg-muted/50 px-4 py-2 text-center text-sm">{syncResult}</p>
        )}

        {!peer.peerEndpoint && (
          <p className="text-center text-xs text-muted-foreground">{t('sync.noEndpointHint')}</p>
        )}
        {peer.peerEndpoint && !peerOnline && (
          <p className="text-center text-xs text-muted-foreground">{t('sync.peerOfflineHint')}</p>
        )}

        {/* Remove peer */}
        <div className="border-t pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="w-full gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={loading}
            onClick={async () => {
              await onRemoveTrustedPeer(peer.peerDeviceId)
              setActivePeer(null)
              setView('home')
            }}
          >
            <Trash2 className="h-4 w-4" />
            {t('sync.removePeer')}
          </Button>
        </div>
      </div>
    )
  }

  return null
}
