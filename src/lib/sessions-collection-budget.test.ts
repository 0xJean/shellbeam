import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runSshCommand } from './sessions'
import { COLLECTION_LIMITS } from './collection-limits'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
describe('Native command budget IPC', () => {
  it('normalizes explicit invalid deadlines before IPC and cannot extend ordinary commands', async () => {
    const request = { host: 'machine', port: 22, username: 'ops', authType: 'password' as const, command: 'uptime' }
    for (const [value, expected] of [[NaN, COLLECTION_LIMITS.remote.commandTimeoutMs], [Infinity, COLLECTION_LIMITS.remote.commandTimeoutMs], [-1, COLLECTION_LIMITS.remote.minCommandTimeoutMs], [Number.MAX_SAFE_INTEGER, COLLECTION_LIMITS.remote.commandTimeoutMs], [COLLECTION_LIMITS.remote.collectorTimeoutMs, COLLECTION_LIMITS.remote.collectorTimeoutMs]]) {
      await runSshCommand({ ...request, timeoutMs: value })
      expect(invoke).toHaveBeenLastCalledWith('run_ssh_command', { payload: { ...request, timeoutMs: expected } })
    }
  })
})
