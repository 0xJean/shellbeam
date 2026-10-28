import { beforeEach, describe, expect, it } from 'vitest'
import { healthCheckHistoryStorageKey, healthCheckStorageKey } from './health-checks'
import { getHostObservationKey } from './host-observation-scope'
import { localOpsStorageKey } from './local-ops-store'
import { SCHEDULED_TASK_STORAGE_PREFIX } from './scheduled-tasks'
import { clearVaultLocalData, isVaultLocalStorageKey } from './vault-local-cleanup'

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
})
