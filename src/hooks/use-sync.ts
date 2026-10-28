import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { androidNsdRegister, getAndroidDeviceName } from '@/lib/mdns'
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
  syncClaimPendingFromPeer,
  type SyncBootstrapResponse,
  type SyncChangeRecord,
  type SyncCursorRecord,
  type SyncDeviceIdentity,
  type SyncPairingSession,
  type SyncTrustedPeer,
  type SyncDataOptions,
  type SyncDataChangedPayload,
} from '@/lib/sync'

/**
 * `activeVaultId` is the vault pull/push sync; `onSyncComplete` only fires for
 * restores into that vault (other vaults' data is reloaded when switched to).
 */
export function useSync(setOutput: (msg: string) => void, onSyncComplete?: () => void, activeVaultId?: string) {
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
  const activeVaultIdRef = useRef(activeVaultId)
  activeVaultIdRef.current = activeVaultId
  const isActiveVault = (vaultId?: string) => !vaultId || !activeVaultIdRef.current || vaultId === activeVaultIdRef.current

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

    // Auto-correct bad device names on Android when the NSD bridge is available
    if (bs.localDevice) {
      const badNames = ['localhost', 'shellbeam-android']
      if (badNames.includes(bs.localDevice.deviceName.toLowerCase())) {
        const androidName = getAndroidDeviceName()
        if (androidName) {
          const fixed = await syncInitLocalDevice(androidName)
          setLocalDevice(fixed)
        }
      }
    }
  }, [])

  function backgroundRefresh() {
    if (pendingRefreshRef.current) return
    const p = fetchAll().finally(() => { pendingRefreshRef.current = null })
    pendingRefreshRef.current = p
  }

  // Listen for push_full_backup received from a peer — refresh local data
  useEffect(() => {
    const unlisten = listen<SyncDataChangedPayload | null>('sync-data-changed', (event) => {
      console.log('[sync] sync-data-changed event received, refreshing...')
      if (isActiveVault(event.payload?.vaultId ?? undefined)) onSyncCompleteRef.current?.()
      backgroundRefresh()
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  // Listen for pending push stored event (macOS couldn't reach Android directly)
  // and also poll trusted peers for pending pushes periodically
  useEffect(() => {
    const unlisten = listen('sync-pending-push-stored', (event) => {
      const data = event.payload as { peerDeviceId?: string }
      console.log('[sync] pending push stored for peer:', data?.peerDeviceId)
      setOutput('Sync push queued — data will be delivered when peer connects')
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  // Periodically check all trusted peers for pending pushes (Android → macOS polling)
  const trustedPeersRef = useRef(trustedPeers)
  trustedPeersRef.current = trustedPeers

  useEffect(() => {
    if (!serverRunning) return

    let cancelled = false
    const pollPending = async () => {
      const peers = trustedPeersRef.current
      if (peers.length === 0) return
      for (const peer of peers) {
        if (cancelled) break
        if (!peer.peerEndpoint) continue
        try {
          const result = await syncClaimPendingFromPeer(peer.peerDeviceId)
          if (result.claimed) {
            const parts: string[] = []
            if (result.hostsRestored) parts.push(`${result.hostsRestored} hosts`)
            if (result.snippetsRestored) parts.push(`${result.snippetsRestored} snippets`)
            if (result.vaultRestored) parts.push('vault/keychain')
            setOutput(`Received pending push from ${peer.peerDeviceName ?? peer.peerDeviceId}: ${parts.join(', ')}`)
            if (isActiveVault(result.vaultId)) onSyncCompleteRef.current?.()
            backgroundRefresh()
          }
        } catch {
          // Peer unreachable — that's fine, skip silently
        }
      }
    }

    // Poll once immediately, then every 30 seconds
    pollPending()
    const timer = setInterval(pollPending, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [serverRunning])

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
      // On Android, use the real device model name if no name provided
      let name = deviceName?.trim()
      if (!name) {
        const androidName = getAndroidDeviceName()
        if (androidName) name = androidName
      }
      const device = await syncInitLocalDevice(name || undefined)
      setLocalDevice(device)
      setOutput(`Sync local device ready: ${device.deviceName}`)

      // If the persisted device name is a known bad fallback (e.g. "localhost",
      // "ShellBeam-Android") and we now have the real Android device name,
      // re-init to fix it.
      const badNames = ['localhost', 'shellbeam-android']
      const androidName2 = getAndroidDeviceName()
      if (androidName2 && badNames.includes(device.deviceName.toLowerCase())) {
        const fixed = await syncInitLocalDevice(androidName2)
        setLocalDevice(fixed)
        setOutput(`Sync device name corrected: ${fixed.deviceName}`)
      }
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
      // On Android, register NSD service via native bridge with real device name
      const androidName = getAndroidDeviceName()
      let nsdName = androidName || localDevice?.deviceName || 'ShellBeam'
      // Avoid registering with known-bad fallback names
      const badNames = ['localhost', 'shellbeam-android']
      if (badNames.includes(nsdName.toLowerCase())) {
        nsdName = androidName || 'ShellBeam'
      }
      androidNsdRegister(p, nsdName)

      // If the persisted device name is a bad fallback and we now have the real
      // Android name, fix it so future syncs use the correct name.
      if (androidName && localDevice && badNames.includes(localDevice.deviceName.toLowerCase())) {
        const fixed = await syncInitLocalDevice(androidName)
        setLocalDevice(fixed)
      }
    } catch (error) {
      setOutput(String(error))
    } finally {
      setLoading(false)
    }
  }

  async function handlePullFromPeer(peerDeviceId: string, options?: SyncDataOptions) {
    setLoading(true)
    try {
      const result = await syncPullFromPeer(peerDeviceId, options, activeVaultId)
      const parts: string[] = []
      if (result.hostsRestored) parts.push(`${result.hostsRestored} hosts`)
      if (result.snippetsRestored) parts.push(`${result.snippetsRestored} snippets`)
      if (result.vaultRestored) parts.push('vault/keychain')
      if (parts.length > 0) {
        setOutput(`Sync pull complete: ${parts.join(', ')}`)
      } else {
        setOutput('Sync pull complete: peer has no data to share')
      }
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
      const result = await syncPushToPeer(peerDeviceId, options, activeVaultId)
      const parts: string[] = []
      if (result.hostsPushed) parts.push(`${result.hostsPushed} hosts`)
      if (result.snippetsPushed) parts.push(`${result.snippetsPushed} snippets`)
      if (result.vaultPushed) parts.push('vault/keychain')
      if (parts.length > 0) {
        setOutput(`Sync push complete: ${parts.join(', ')}`)
      } else {
        setOutput('Sync push complete: no data to push')
      }
    } catch (error) {
      const msg = String(error)
      // If the error mentions pending, it means the push was queued
      if (msg.includes('pending')) {
        setOutput('Sync push queued — data will be delivered when peer connects')
      } else {
        setOutput(msg)
      }
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
