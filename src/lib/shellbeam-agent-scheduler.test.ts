import { describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import {
  createShellbeamAgentScheduler,
  type ShellbeamAgentScheduleOptions,
} from './shellbeam-agent-scheduler'
import { normalizeShellbeamAgentRecord, type ShellbeamAgentRecord } from './shellbeam-agent'

const hosts: HostProfile[] = Array.from({ length: 5 }, (_, index) => ({
  id: `host-${index + 1}`,
  name: `edge-${index + 1}`,
  address: `10.0.0.${index + 1}`,
  port: 22,
  username: 'ops',
  group: 'Production',
  authType: 'privateKey',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}))

function baseOptions(overrides: Partial<ShellbeamAgentScheduleOptions> = {}): ShellbeamAgentScheduleOptions {
  return {
    hosts,
    vaultId: 'vault-1',
    resolveAuthSecret: vi.fn(async () => 'secret'),
    now: () => 1_000,
    intervalMs: 60_000,
    concurrency: 2,
    ...overrides,
  }
}

describe('ShellBeam Probe background scheduler', () => {
  it('bounds concurrent checks and persists only lifecycle summaries', async () => {
    let active = 0
    let maxActive = 0
    const persisted: string[] = []
    const check = vi.fn(async (host: HostProfile) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return {
        record: normalizeShellbeamAgentRecord({
          hostId: host.id,
          status: 'installed',
          health: 'online',
          transport: 'direct',
          lastHeartbeatAt: 1_000,
          lastCheckedAt: 1_000,
        }, 1_000),
        stdout: 'secret output must not persist',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }
    })
    const scheduler = createShellbeamAgentScheduler(baseOptions({
      check,
      persist: async (record) => persisted.push(`${record.vaultId}:${record.hostId}:${record.status}`),
    }))

    const result = await scheduler.scanNow()

    expect(result.checkedHosts).toHaveLength(hosts.length)
    expect(result.records).toHaveLength(hosts.length)
    expect(check).toHaveBeenCalledTimes(hosts.length)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(persisted).toHaveLength(hosts.length)
    expect(persisted.every((entry) => entry.includes('vault-1:'))).toBe(true)
  })

  it('deduplicates a host inside the TTL window and supports a forced refresh', async () => {
    const check = vi.fn(async (host: HostProfile) => ({
      record: normalizeShellbeamAgentRecord({ hostId: host.id, status: 'installed', transport: 'direct', lastCheckedAt: 1_000 }, 1_000),
      stdout: '', stderr: '', exitCode: 0, durationMs: 1,
    }))
    const scheduler = createShellbeamAgentScheduler(baseOptions({ check, concurrency: 1 }))

    const first = await scheduler.scanNow()
    const second = await scheduler.scanNow()
    const forced = await scheduler.scanNow({ force: true })

    expect(first.checkedHosts).toHaveLength(hosts.length)
    expect(second.checkedHosts).toHaveLength(0)
    expect(second.skippedHosts).toHaveLength(hosts.length)
    expect(forced.checkedHosts).toHaveLength(hosts.length)
    expect(check).toHaveBeenCalledTimes(hosts.length * 2)
  })

  it('records an unknown timeout and continues to the next host', async () => {
    const errors: unknown[] = []
    const check = vi.fn((host: HostProfile) => host.id === hosts[0].id
      ? new Promise<never>(() => undefined)
      : Promise.resolve({
        record: normalizeShellbeamAgentRecord({ hostId: host.id, status: 'installed', transport: 'direct', lastCheckedAt: 1_000 }, 1_000),
        stdout: '', stderr: '', exitCode: 0, durationMs: 1,
      }))
    const scheduler = createShellbeamAgentScheduler(baseOptions({
      check,
      concurrency: 2,
      timeoutMs: 5,
      onError: (error) => errors.push(error),
    }))

    const result = await scheduler.scanNow()
    const timedOut = result.records.find((record) => record.hostId === hosts[0].id)

    expect(result.checkedHosts).toHaveLength(hosts.length)
    expect(timedOut?.status).toBe('unknown')
    expect(timedOut?.lastErrorCode).toBe('agent_check_timeout')
    expect(errors.some((error) => error instanceof Error && error.name === 'ShellbeamAgentCheckTimeoutError')).toBe(true)
  })

  it('preserves the last known artifact metadata when a check fails', async () => {
    const previous = normalizeShellbeamAgentRecord({
      vaultId: 'vault-1',
      hostId: hosts[0].id,
      status: 'installed',
      health: 'online',
      version: '0.2.0',
      installPath: '$HOME/.local/bin/shellbeam-agent',
      capabilities: ['heartbeat', 'metrics'],
      transport: 'direct',
      lastHeartbeatAt: 1_000,
      lastCheckedAt: 1_000,
    }, 1_000)
    const persisted: ShellbeamAgentRecord[] = []
    const scheduler = createShellbeamAgentScheduler(baseOptions({
      hosts: [hosts[0]],
      previousRecords: [previous],
      timeoutMs: 5,
      check: () => new Promise<never>(() => undefined),
      persist: async (record) => { persisted.push(record) },
    }))

    const result = await scheduler.scanNow()

    expect(result.records[0]).toMatchObject({
      status: 'unknown',
      health: 'unknown',
      version: '0.2.0',
      installPath: '$HOME/.local/bin/shellbeam-agent',
      capabilities: ['heartbeat', 'metrics'],
    })
    expect(persisted[0]).toMatchObject({ version: '0.2.0', installPath: '$HOME/.local/bin/shellbeam-agent' })
  })

  it('redacts credential-like details from scheduler error callbacks', async () => {
    const errors: unknown[] = []
    const scheduler = createShellbeamAgentScheduler(baseOptions({
      hosts: [hosts[0]],
      check: async () => { throw new Error('connection failed password=super-secret token abc123') },
      onError: (error) => errors.push(error),
    }))

    await scheduler.scanNow()

    const message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    expect(message).not.toContain('super-secret')
    expect(message).not.toContain('abc123')
    expect(message).toContain('<redacted>')
  })

  it('stops future ticks and does not persist a result after shutdown', async () => {
    const persisted: string[] = []
    let resolveCheck: ((result: Awaited<ReturnType<NonNullable<ShellbeamAgentScheduleOptions['check']>>>) => void) | undefined
    const check = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<ShellbeamAgentScheduleOptions['check']>>>>((resolve) => {
      resolveCheck = resolve
    }))
    const scheduler = createShellbeamAgentScheduler(baseOptions({ check, persist: async (record) => persisted.push(record.hostId) }))
    scheduler.start()
    scheduler.stop()
    resolveCheck?.({
      record: normalizeShellbeamAgentRecord({ hostId: hosts[0].id, status: 'installed', transport: 'direct', lastCheckedAt: 1_000 }, 1_000),
      stdout: '', stderr: '', exitCode: 0, durationMs: 1,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(scheduler.isRunning()).toBe(false)
    expect(persisted).toHaveLength(0)
  })
})
