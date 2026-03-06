import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export async function getSystemHostname(): Promise<string> {
  try {
    return await invoke<string>('get_system_hostname')
  } catch {
    return ''
  }
}

export interface SyncDeviceIdentity {
  deviceId: string
  deviceName: string
  publicKey: string
  createdAt: number
  lastSeenAt: number
}

export interface SyncChangeRecord {
  version: number
  changeId: string
  objectType: string
  objectId: string
  updatedAt: number
  updatedBy: string
  checksum?: string
  deleted: boolean
  summary?: string
}

export interface SyncCursorRecord {
  peerDeviceId: string
  lastPulledVersion: number
  lastPushedVersion: number
  updatedAt: number
}

export interface SyncBootstrapResponse {
  schemaVersion: number
  localDevice?: SyncDeviceIdentity
  latestVersion: number
  changeCount: number
  cursorCount: number
  trustedPeerCount: number
  activePairingCount: number
}

export interface SyncTrustedPeer {
  peerDeviceId: string
  peerDeviceName?: string
  verifiedAt: number
  lastSeenAt: number
  source: string
  peerEndpoint?: string
}

export interface SyncPairingSession {
  sessionId: string
  initiatorDeviceId: string
  initiatorDeviceName: string
  verificationCode: string
  status: string
  createdAt: number
  expiresAt: number
}

export async function syncGetBootstrap() {
  try {
    return await invoke<SyncBootstrapResponse>('sync_get_bootstrap')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncInitLocalDevice(deviceName?: string) {
  try {
    return await invoke<SyncDeviceIdentity>('sync_init_local_device', { payload: { deviceName } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncRegisterChange(payload: {
  objectType: string
  objectId: string
  updatedBy?: string
  checksum?: string
  deleted?: boolean
  summary?: string
}) {
  try {
    return await invoke<SyncChangeRecord>('sync_register_change', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncQueryChanges(payload?: { sinceVersion?: number; limit?: number }) {
  try {
    return await invoke<SyncChangeRecord[]>('sync_query_changes', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncUpsertCursor(payload: {
  peerDeviceId: string
  lastPulledVersion?: number
  lastPushedVersion?: number
}) {
  try {
    return await invoke<SyncCursorRecord>('sync_upsert_cursor', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncListCursors() {
  try {
    return await invoke<SyncCursorRecord[]>('sync_list_cursors')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncStartPairing(payload?: { peerDeviceNameHint?: string }) {
  try {
    return await invoke<SyncPairingSession>('sync_start_pairing', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncConfirmPairing(payload: {
  sessionId: string
  verificationCode: string
  peerDeviceId?: string
  peerDeviceName?: string
}) {
  try {
    return await invoke<SyncTrustedPeer>('sync_confirm_pairing', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncSendPairRequest(payload: {
  peerHost: string
  peerPort: number
  peerName?: string
}) {
  try {
    return await invoke<SyncPairingSession>('sync_send_pair_request', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncAcceptPair(payload: {
  sessionId: string
  peerHost: string
  peerPort: number
}) {
  try {
    return await invoke<SyncTrustedPeer>('sync_accept_pair', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncListTrustedPeers() {
  try {
    return await invoke<SyncTrustedPeer[]>('sync_list_trusted_peers')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncListPairingSessions() {
  try {
    return await invoke<SyncPairingSession[]>('sync_list_pairing_sessions')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncUpdatePeerEndpoint(peerDeviceId: string, peerEndpoint?: string) {
  try {
    return await invoke<SyncTrustedPeer>('sync_update_peer_endpoint', {
      payload: { peerDeviceId, peerEndpoint },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncRemoveTrustedPeer(peerDeviceId: string) {
  try {
    await invoke<void>('sync_remove_trusted_peer', {
      payload: { peerDeviceId },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncStartServer(port?: number) {
  try {
    return await invoke<number>('sync_start_server', { port })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function syncServerStatus() {
  try {
    return await invoke<[boolean, number]>('sync_server_status')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export interface SyncDataOptions {
  includeHosts?: boolean
  includeSnippets?: boolean
  includeVault?: boolean
}

export interface SyncPullResult {
  hostsRestored: number
  snippetsRestored: number
  vaultRestored: boolean
}

export async function syncPullFromPeer(peerDeviceId: string, options?: SyncDataOptions) {
  try {
    return await invoke<SyncPullResult>('sync_pull_from_peer', {
      payload: { peerDeviceId, options },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export interface SyncPushResult {
  hostsPushed: number
  snippetsPushed: number
  vaultPushed: boolean
}

export async function syncPushToPeer(peerDeviceId: string, options?: SyncDataOptions) {
  try {
    return await invoke<SyncPushResult>('sync_push_to_peer', {
      payload: { peerDeviceId, options },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
