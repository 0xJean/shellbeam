import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { androidNsdRegister } from '@/lib/mdns'
import {
  syncGetBootstrap,
  syncInitLocalDevice,
  syncListPairingSessions,
  syncListCursors,
  syncListTrustedPeers,
  syncStartPairing,
  syncConfirmPairing,
  syncQueryChanges,
  syncRegisterChange,
  syncUpdatePeerEndpoint,
  syncRemoveTrustedPeer,
  syncStartServer,
  syncServerStatus,
  syncPullFromPeer,
  syncPushToPeer,
  type SyncBootstrapResponse,
  type SyncChangeRecord,
  type SyncCursorRecord,
  type SyncDeviceIdentity,
  type SyncPairingSession,
  type SyncTrustedPeer,
  type SyncDataOptions,
} from '@/lib/sync'

export function useSync(setOutput: (msg: string) => void, onSyncComplete?: () => void) {
  const [bootstrap, setBootstrap] = useState<SyncBootstrapResponse | null>(null)
  const [localDevice, setLocalDevice] = useState<SyncDeviceIdentity | null>(null)
  const [changes, setChanges] = useState<SyncChangeRecord[]>([])
  const [cursors, setCursors] = useState<SyncCursorRecord[]>([])
  const [trustedPeers, setTrustedPeers] = useState<SyncTrustedPeer[]>([])
  const [pairingSessions, setPairingSessions] = useState<SyncPairingSession[]>([])
  const [loading, setLoading] = useState(false)
  const [serverRunning, setServerRunning] = useState(false)
  const [serverPort, setServerPort] = useState(0)

  const pendingRefreshRef = useRef<Promise<void> | null>(null)
  const onSyncCompleteRef = useRef(onSyncComplete)
  onSyncCompleteRef.current = onSyncComplete

  const fetchAll = useCallback(async () => {
    const [bs, ch, cu, tp, ps, [sr, sp]] = await Promise.all([
      syncGetBootstrap(),
      syncQueryChanges({ sinceVersion: 0, limit: 300 }),
      syncListCursors(),
      syncListTrustedPeers(),
      syncListPairingSessions(),
      syncServerStatus(),
    ])
    setBootstrap(bs)
    setLocalDevice(bs.localDevice ?? null)
    setChanges(ch)
    setCursors(cu)
    setTrustedPeers(tp)
    setPairingSessions(ps)
    setServerRunning(sr)
    setServerPort(sp)
  }, [])

  function backgroundRefresh() {
    if (pendingRefreshRef.current) return
    const p = fetchAll().finally(() => { pendingRefreshRef.current = null })
    pendingRefreshRef.current = p
  }

  // Listen for push_full_backup received from a peer — refresh local data
  useEffect(() => {
    const unlisten = listen('sync-data-changed', () => {
      onSyncCompleteRef.current?.()
      backgroundRefresh()
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  async function refresh() {
    setLoading(true)
    try {
      await fetchAll()
    } finally {
      setLoading(false)
    }
  }

  async function handleInitDevice(deviceName?: string) {
    setLoading(true)
    try {
      const device = await syncInitLocalDevice(deviceName?.trim() || undefined)
      setLocalDevice(device)
      setOutput(`Sync local device ready: ${device.deviceName}`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
    backgroundRefresh()
  }

  async function handleMockRegisterChange(objectType: string, objectId: string, summary?: string) {
    setLoading(true)
    try {
      await syncRegisterChange({ objectType, objectId, summary, updatedBy: localDevice?.deviceId })
      setOutput(`Sync mock change appended: ${objectType}/${objectId}`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
    backgroundRefresh()
  }

  async function handleStartPairing(peerDeviceNameHint?: string) {
    setLoading(true)
    try {
      const session = await syncStartPairing({ peerDeviceNameHint: peerDeviceNameHint?.trim() || undefined })
      const ps = await syncListPairingSessions()
      setPairingSessions(ps)
      setOutput(`Pairing started: ${session.sessionId} (code: ${session.verificationCode})`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmPairing(sessionId: string, verificationCode: string, peerDeviceName?: string) {
    setLoading(true)
    try {
      const peer = await syncConfirmPairing({
        sessionId: sessionId.trim(),
        verificationCode: verificationCode.trim(),
        peerDeviceName: peerDeviceName?.trim() || undefined,
      })
      const tp = await syncListTrustedPeers()
      setTrustedPeers(tp)
      setOutput(`Pairing confirmed with peer: ${peer.peerDeviceId}`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
    backgroundRefresh()
  }

  async function handleUpdatePeerEndpoint(peerDeviceId: string, peerEndpoint?: string) {
    setLoading(true)
    try {
      const updated = await syncUpdatePeerEndpoint(peerDeviceId, peerEndpoint)
      setTrustedPeers((prev) => prev.map((p) => (p.peerDeviceId === peerDeviceId ? updated : p)))
      setOutput(`Peer endpoint updated: ${peerDeviceId}`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
  }

  async function handleStartServer(port?: number) {
    setLoading(true)
    try {
      const p = await syncStartServer(port)
      setServerRunning(true)
      setServerPort(p)
      setOutput(`Sync server started on port ${p}`)
      // On Android, register NSD service via native bridge
      androidNsdRegister(p, localDevice?.deviceName || 'ShellBeam')
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
  }

  async function handlePullFromPeer(peerDeviceId: string, options?: SyncDataOptions) {
    setLoading(true)
    try {
      const result = await syncPullFromPeer(peerDeviceId, options)
      const parts: string[] = []
      if (result.hostsRestored) parts.push(`${result.hostsRestored} hosts`)
      if (result.snippetsRestored) parts.push(`${result.snippetsRestored} snippets`)
      if (result.vaultRestored) parts.push('vault/keychain')
      setOutput(`Sync pull complete: ${parts.join(', ') || 'no data'}`)
      onSyncComplete?.()
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
    backgroundRefresh()
  }

  async function handlePushToPeer(peerDeviceId: string, options?: SyncDataOptions) {
    setLoading(true)
    try {
      const result = await syncPushToPeer(peerDeviceId, options)
      const parts: string[] = []
      if (result.hostsPushed) parts.push(`${result.hostsPushed} hosts`)
      if (result.snippetsPushed) parts.push(`${result.snippetsPushed} snippets`)
      if (result.vaultPushed) parts.push('vault/keychain')
      setOutput(`Sync push complete: ${parts.join(', ') || 'no data'}`)
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
    backgroundRefresh()
  }

  async function handleRemoveTrustedPeer(peerDeviceId: string) {
    setLoading(true)
    try {
      await syncRemoveTrustedPeer(peerDeviceId)
      setTrustedPeers((prev) => prev.filter((p) => p.peerDeviceId !== peerDeviceId))
      setOutput('Trusted peer removed')
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
  }

  return {
    bootstrap, localDevice, changes, cursors, trustedPeers,
    pairingSessions, loading, serverRunning, serverPort,
    refresh,
    handleInitDevice, handleMockRegisterChange, handleStartPairing,
    handleConfirmPairing, handleUpdatePeerEndpoint, handleStartServer,
    handlePullFromPeer, handlePushToPeer, handleRemoveTrustedPeer,
  }
}
