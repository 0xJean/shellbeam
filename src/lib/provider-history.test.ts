import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { appendProviderMetricHistory, listProviderMetricHistory, observationToMetricHistoryPoint } from './provider-history'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
describe('Provider metric history persistence boundary', () => {
  it('keeps scope and original sample freshness separate from metric payloads', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const point = observationToMetricHistoryPoint({ source: { kind: 'komari', id: 'source', nodeId: 'node', capabilities: ['metrics'] }, data: { cpuPercent: 10, sampledAt: 100 } as never, freshness: { sampledAt: 100, receivedAt: 200, ttlMs: 1000, expiresAt: 1100, expired: false }, confidence: 'partial' }, 'host')
    await appendProviderMetricHistory('vault-a', [point])
    expect(invoke).toHaveBeenCalledWith('append_provider_metric_history', { payload: { vaultId: 'vault-a', points: [expect.objectContaining({ hostId: 'host', providerId: 'source', nodeId: 'node', sampledAt: 100, expiresAt: 1100 })] } })
    await expect(listProviderMetricHistory({ vaultId: '', hostId: 'host' })).rejects.toThrow('scope_invalid')
  })
})
