import { describe, expect, it } from 'vitest'
import {
  SERVER_MONITOR_COMMAND,
  isUsableServerMonitorSnapshot,
  parseServerMonitorOutput,
} from './server-monitor'

describe('server monitor parser', () => {
  it('parses a complete Linux sample into numeric metrics', () => {
    const snapshot = parseServerMonitorOutput(`
__SB_MON_HOSTNAME=prod-api
__SB_MON_OS=Ubuntu 24.04 LTS
__SB_MON_KERNEL=Linux 6.8
__SB_MON_UPTIME=86400
__SB_MON_LOAD=0.50|0.40|0.30
__SB_MON_CPU=23.4
__SB_MON_MEMORY=640000000|1000000000|64
__SB_MON_DISK=740000000|1000000000|74
__SB_MON_NETWORK=1024|2048
`, 123)

    expect(snapshot).toMatchObject({
      hostname: 'prod-api',
      os: 'Ubuntu 24.04 LTS',
      uptimeSeconds: 86400,
      load1: 0.5,
      cpuPercent: 23.4,
      memoryUsedBytes: 640000000,
      memoryPercent: 64,
      diskPercent: 74,
      networkRxBytesPerSec: 1024,
      networkTxBytesPerSec: 2048,
      sampledAt: 123,
    })
    expect(isUsableServerMonitorSnapshot(snapshot)).toBe(true)
  })

  it('keeps missing fields null without invalidating the complete sample', () => {
    const snapshot = parseServerMonitorOutput('__SB_MON_HOSTNAME=partial\n__SB_MON_CPU=18')

    expect(snapshot.hostname).toBe('partial')
    expect(snapshot.cpuPercent).toBe(18)
    expect(snapshot.memoryPercent).toBeNull()
    expect(snapshot.networkRxBytesPerSec).toBeNull()
    expect(isUsableServerMonitorSnapshot(snapshot)).toBe(true)
  })

  it('clamps percentages and rejects negative rates', () => {
    const snapshot = parseServerMonitorOutput(`
__SB_MON_CPU=180
__SB_MON_MEMORY=-20|100|-5
__SB_MON_DISK=100|200|120
__SB_MON_NETWORK=-1|-2
__SB_MON_LOAD=-1|2|3
`)

    expect(snapshot.cpuPercent).toBe(100)
    expect(snapshot.memoryUsedBytes).toBe(0)
    expect(snapshot.memoryTotalBytes).toBe(100)
    expect(snapshot.memoryPercent).toBe(0)
    expect(snapshot.diskPercent).toBe(100)
    expect(snapshot.networkRxBytesPerSec).toBe(0)
    expect(snapshot.networkTxBytesPerSec).toBe(0)
    expect(snapshot.load1).toBe(0)
  })

  it('does not treat empty or metadata-only output as a usable sample', () => {
    expect(isUsableServerMonitorSnapshot(parseServerMonitorOutput(''))).toBe(false)
    expect(isUsableServerMonitorSnapshot(parseServerMonitorOutput('__SB_MON_HOSTNAME=only-name'))).toBe(false)
  })

  it('uses read-only Linux probes and does not include installation or control actions', () => {
    expect(SERVER_MONITOR_COMMAND).toContain('/proc/stat')
    expect(SERVER_MONITOR_COMMAND).toContain('/proc/meminfo')
    expect(SERVER_MONITOR_COMMAND).toContain('df -Pk /')
    expect(SERVER_MONITOR_COMMAND).not.toMatch(/\b(apt|yum|dnf|systemctl|service|docker|npm|rm|touch|install)\b/)
  })
})
