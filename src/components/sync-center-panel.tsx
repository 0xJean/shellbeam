import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Monitor,
  Loader2,
  RefreshCw,
  Radio,
  ArrowLeft,
  ShieldCheck,
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
import { cn } from '@/lib/utils'
import { ScanningView, PairingView, ConfirmingView, IncomingPairView, ConnectFailedView } from './sync-pairing-views'
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
}

export function SyncCenterPanel({
  localDevice, changes, cursors: _cursors, trustedPeers,
  loading, serverRunning, serverPort,
  onRefresh, onInitDevice, onStartServer,
  onPullFromPeer, onPushToPeer, onRemoveTrustedPeer,
}: SyncCenterPanelProps) {
  const { t } = useT()
  const [view, setView] = useState<SyncView>('home')
  const [activePeer, setActivePeer] = useState<SyncTrustedPeer | null>(null)
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
                    onClick={() => { setActivePeer(peer); setView('peer-detail') }}
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
      <ScanningView
        scanning={scanning}
        discoveredDevices={discoveredDevices}
        selectedDevice={selectedDevice}
        onSelectDevice={(d) => void handleSelectDeviceAndPair(d)}
        onRescan={startScan}
        onCancel={handleCancel}
      />
    )
  }

  // ── Pairing / waiting ─────────────────────────────────────────────────────
  if (view === 'pairing') {
    return (
      <PairingView
        selectedDeviceName={selectedDevice?.name ?? 'peer device'}
        pairingError={pairingError}
        onCancel={handleCancel}
      />
    )
  }

  // ── Confirming (initiator side — shows PIN, waiting for peer to accept) ──
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

  // ── Incoming pair request (receiver side — shows PIN + accept/reject) ────
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

  // ── Connect failed — device blocks inbound TCP (Android) ─────────────────
  if (view === 'connect-failed' && selectedDevice) {
    return (
      <ConnectFailedView
        device={selectedDevice}
        onCancel={handleCancel}
      />
    )
  }

  // ── Peer detail view (push / pull / remove) ──────────────────────────────
  if (view === 'peer-detail' && activePeer) {
    const peer = trustedPeers.find((p) => p.peerDeviceId === activePeer.peerDeviceId) ?? activePeer
    const peerOnline = isPeerOnline(peer)
    return (
      <SyncPeerDetail
        peer={peer}
        peerOnline={peerOnline}
        loading={loading}
        onBack={() => { setActivePeer(null); setView('home') }}
        onPullFromPeer={onPullFromPeer}
        onPushToPeer={onPushToPeer}
        onRemoveTrustedPeer={onRemoveTrustedPeer}
      />
    )
  }

  return null
}
