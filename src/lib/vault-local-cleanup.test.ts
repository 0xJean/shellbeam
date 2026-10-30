import { beforeEach, describe, expect, it } from 'vitest'
import { healthCheckHistoryStorageKey, healthCheckStorageKey } from './health-checks'
import { getHostObservationKey } from './host-observation-scope'
import { localOpsStorageKey } from './local-ops-store'
import { SCHEDULED_TASK_STORAGE_PREFIX } from './scheduled-tasks'
import { clearHostLocalData, clearVaultLocalData, hostObservationKey, isHostLocalStorageKey, isVaultLocalStorageKey } from './vault-local-cleanup'

const host = (vaultId: string, id: string) => ({ id, vaultId, username: 'u', address: 'a', port: 22 })

describe('vault local cleanup', () => {
  beforeEach(() => localStorage.clear())

  it('matches the keys the real builders produce for the deleted Vault only', () => {
    for (const vaultId of ['team', 'a b/c']) {
      for (const key of [
        localOpsStorageKey(vaultId, 'h1', 'rules'),
        healthCheckStorageKey(vaultId, 'h1'),
        healthCheckHistoryStorageKey(vaultId, 'h1'),
        `${SCHEDULED_TASK_STORAGE_PREFIX}:${vaultId}:h1`,
        `shellbeam.certificates.${vaultId}`,
        `shellbeam:host-monitoring-summary:${vaultId}`,
        `shellbeam.interactiveHistory:${vaultId}`,
      ]) expect(isVaultLocalStorageKey(key, vaultId), key).toBe(true)
    }
    for (const key of [
      localOpsStorageKey('team2', 'h1', 'rules'),
      healthCheckStorageKey('teamx', 'h1'),
      healthCheckHistoryStorageKey('personal', 'team'),
      `${SCHEDULED_TASK_STORAGE_PREFIX}:te:h1`,
      'shellbeam.certificates.team2',
      'shellbeam.interactiveHistory',
      'shellbeam.interactiveHistory:team2',
      'shellbeam.locale',
    ]) expect(isVaultLocalStorageKey(key, 'team'), key).toBe(false)
    expect(isVaultLocalStorageKey('shellbeam.certificates.', '')).toBe(false)
  })

  it('removes Vault keys and prunes its observation entries from the shared inventory cache', () => {
    localStorage.setItem(localOpsStorageKey('team', 'h1', 'rules'), '[]')
    localStorage.setItem('shellbeam.certificates.team', '[]')
    localStorage.setItem('shellbeam.interactiveHistory:team', '{}')
    localStorage.setItem('shellbeam.certificates.personal', '[]')
    localStorage.setItem('shellbeam.interactiveHistory:personal', '{}')
    localStorage.setItem('shellbeam.workspaceInventoryCache.v1', JSON.stringify({
      [getHostObservationKey(host('team', 'h1'))]: { updatedAt: 1 },
      [getHostObservationKey(host('team2', 'h1'))]: { updatedAt: 2 },
      legacy: { updatedAt: 3 },
    }))

    const touched = clearVaultLocalData('team')

    expect(touched).toHaveLength(4)
    expect(localStorage.getItem(localOpsStorageKey('team', 'h1', 'rules'))).toBeNull()
    expect(localStorage.getItem('shellbeam.certificates.team')).toBeNull()
    expect(localStorage.getItem('shellbeam.interactiveHistory:team')).toBeNull()
    expect(localStorage.getItem('shellbeam.certificates.personal')).toBe('[]')
    expect(localStorage.getItem('shellbeam.interactiveHistory:personal')).toBe('{}')
    expect(Object.keys(JSON.parse(localStorage.getItem('shellbeam.workspaceInventoryCache.v1')!))).toEqual([
      getHostObservationKey(host('team2', 'h1')),
      'legacy',
    ])
  })

  it('leaves storage alone for an empty id', () => {
    localStorage.setItem('shellbeam.certificates.', '[]')
    expect(clearVaultLocalData('')).toEqual([])
    expect(localStorage.length).toBe(1)
  })

  it('matches the host-scoped builders for the moved host only', () => {
    for (const [vaultId, hostId] of [['team', 'h1'], ['a b/c', 'h:1']]) {
      for (const key of [
        localOpsStorageKey(vaultId, hostId, 'rules'),
        healthCheckStorageKey(vaultId, hostId),
        healthCheckHistoryStorageKey(vaultId, hostId),
        `${SCHEDULED_TASK_STORAGE_PREFIX}:${vaultId}:${hostId}`,
      ]) expect(isHostLocalStorageKey(key, vaultId, hostId), key).toBe(true)
    }
    for (const key of [
      localOpsStorageKey('team', 'h10', 'rules'),
      localOpsStorageKey('team2', 'h1', 'rules'),
      healthCheckStorageKey('team', 'h10'),
      healthCheckHistoryStorageKey('team', 'h10'),
      `${SCHEDULED_TASK_STORAGE_PREFIX}:team:h10`,
      'shellbeam.certificates.team',
      'shellbeam.interactiveHistory:team',
    ]) expect(isHostLocalStorageKey(key, 'team', 'h1'), key).toBe(false)
    expect(isHostLocalStorageKey(healthCheckStorageKey('team', 'h1'), 'team', '')).toBe(false)
    expect(hostObservationKey('team', 'h1')).toBe(getHostObservationKey(host('team', 'h1')))
  })

  it('removes only the moved hosts entries and keeps the Vault and its other hosts', () => {
    const kept = [
      localOpsStorageKey('team', 'h3', 'rules'),
      healthCheckStorageKey('team', 'h3'),
      localOpsStorageKey('personal', 'h1', 'rules'),
      'shellbeam.certificates.team',
      'shellbeam.interactiveHistory:team',
    ]
    const removed = [
      localOpsStorageKey('team', 'h1', 'rules'),
      healthCheckStorageKey('team', 'h1'),
      healthCheckHistoryStorageKey('team', 'h2'),
      `${SCHEDULED_TASK_STORAGE_PREFIX}:team:h2`,
    ]
    for (const key of [...kept, ...removed]) localStorage.setItem(key, '[]')
    localStorage.setItem('shellbeam.workspaceInventoryCache.v1', JSON.stringify({
      [getHostObservationKey(host('team', 'h1'))]: { updatedAt: 1 },
      [getHostObservationKey(host('team', 'h3'))]: { updatedAt: 2 },
      [getHostObservationKey(host('personal', 'h1'))]: { updatedAt: 3 },
    }))

    const touched = clearHostLocalData('team', ['h1', 'h2'])

    expect(touched.sort()).toEqual([...removed, 'shellbeam.workspaceInventoryCache.v1'].sort())
    for (const key of removed) expect(localStorage.getItem(key), key).toBeNull()
    for (const key of kept) expect(localStorage.getItem(key), key).toBe('[]')
    expect(Object.keys(JSON.parse(localStorage.getItem('shellbeam.workspaceInventoryCache.v1')!))).toEqual([
      getHostObservationKey(host('team', 'h3')),
      getHostObservationKey(host('personal', 'h1')),
    ])
  })

  it('leaves storage alone without a Vault or hosts', () => {
    localStorage.setItem(healthCheckStorageKey('team', 'h1'), '[]')
    expect(clearHostLocalData('', ['h1'])).toEqual([])
    expect(clearHostLocalData('team', [])).toEqual([])
    expect(localStorage.length).toBe(1)
  })
})
