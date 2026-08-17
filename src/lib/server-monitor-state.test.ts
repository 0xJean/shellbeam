import { afterEach, describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import {
  clearServerMonitorStates,
  createServerMonitorLatest,
  getServerMonitorFailureStatus,
  getServerMonitorStates,
} from './server-monitor-state'
import { isServerMonitorVaultUnavailableError } from './server-monitor-scan'

const host: HostProfile = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password',
  secretKeyRef: 'prod-password',
  passwordKeyRef: 'prod-password',
  privateKeyRef: undefined,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('server monitor state', () => {
  afterEach(() => {
    clearServerMonitorStates()
  })

  it('keeps a first attempt in checking state with no snapshot', () => {
    const latest = createServerMonitorLatest(host, 'checking', 100)

    expect(latest.status).toBe('checking')
    expect(latest.snapshot).toBeNull()
    expect(latest.lastSuccessAt).toBeNull()
  })

  it('transitions failures to stale before the five minute threshold', () => {
    const previous = createServerMonitorLatest(host, 'online', 100, undefined, {
      lastSuccessAt: 100,
      snapshot: null,
    })

    expect(getServerMonitorFailureStatus(previous, 100 + 4 * 60 * 1000)).toBe('stale')
    expect(getServerMonitorFailureStatus(previous, 100 + 5 * 60 * 1000 + 1)).toBe('offline')
  })

  it('creates host-specific latest state without sharing references', () => {
    const latest = createServerMonitorLatest(host, 'paused', 200)

    expect(latest.hostKey).toBe('host-1')
    expect(latest.status).toBe('paused')
    expect(getServerMonitorStates()).toEqual({})
  })

  it('recognizes locked and uninitialized vault errors as unavailable credentials', () => {
    expect(isServerMonitorVaultUnavailableError(new Error('Vault 已锁定。'))).toBe(true)
    expect(isServerMonitorVaultUnavailableError(new Error('Vault 尚未初始化。'))).toBe(true)
    expect(isServerMonitorVaultUnavailableError(new Error('SSH connection timed out'))).toBe(false)
  })
})
