import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (event: { payload: unknown }) => void>()
const syncPullFromPeer = vi.fn(async () => ({ hostsRestored: 1, snippetsRestored: 0, vaultRestored: false }))
const syncPushToPeer = vi.fn(async () => ({ hostsPushed: 1, snippetsPushed: 0, vaultPushed: false }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))
vi.mock('@/lib/mdns', () => ({ androidNsdRegister: vi.fn(), getAndroidDeviceName: () => null }))
vi.mock('@/lib/sync', () => ({
  syncGetBootstrap: vi.fn(async () => ({ localDevice: null })),
  syncQueryChanges: vi.fn(async () => []),
  syncListCursors: vi.fn(async () => []),
  syncListTrustedPeers: vi.fn(async () => []),
  syncListPairingSessions: vi.fn(async () => []),
  syncServerStatus: vi.fn(async () => [false, 0]),
  syncPullFromPeer: (...args: unknown[]) => syncPullFromPeer(...(args as [])),
  syncPushToPeer: (...args: unknown[]) => syncPushToPeer(...(args as [])),
  syncClaimPendingFromPeer: vi.fn(),
}))

import { useSync } from './use-sync'

describe('useSync vault scoping', () => {
  beforeEach(() => {
    listeners.clear()
    syncPullFromPeer.mockClear()
    syncPushToPeer.mockClear()
  })

  it('pulls and pushes the active vault', async () => {
    const { result } = renderHook(() => useSync(vi.fn(), vi.fn(), 'vault-work'))
    const opts = { includeHosts: true }
    await act(() => result.current.handlePullFromPeer('peer-1', opts))
    await act(() => result.current.handlePushToPeer('peer-1', opts))
    expect(syncPullFromPeer).toHaveBeenCalledWith('peer-1', opts, 'vault-work')
    expect(syncPushToPeer).toHaveBeenCalledWith('peer-1', opts, 'vault-work')
  })

  it('refreshes data only when the restored vault is active', async () => {
    const onSyncComplete = vi.fn()
    renderHook(() => useSync(vi.fn(), onSyncComplete, 'vault-work'))
    await act(async () => {})
    const emit = listeners.get('sync-data-changed')!
    act(() => emit({ payload: { vaultId: 'personal' } }))
    expect(onSyncComplete).not.toHaveBeenCalled()
    act(() => emit({ payload: { vaultId: 'vault-work' } }))
    expect(onSyncComplete).toHaveBeenCalledTimes(1)
    // Older backends emit no payload: keep refreshing.
    act(() => emit({ payload: null }))
    expect(onSyncComplete).toHaveBeenCalledTimes(2)
  })
})
