import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { vaultGetSecret, vaultStatus } from './vault'
import { metadataPatch, readRemoteHostMetadata, syncHostMetadata, writeRemoteHostMetadata, type HostMetadataBinding } from './host-metadata-sync'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./vault', () => ({ vaultGetSecret: vi.fn(), vaultStatus: vi.fn() }))
const binding = (): HostMetadataBinding => ({ id: 'binding', vaultId: 'v', hostId: 'host', integrationId: 'service', nodeId: 'node', endpoint: 'https://monitor.example', credentialRef: 'existing-ref', integrationVersion: 1, mappingRevision: 1, identity: 'node:2026-01-01T00:00:00Z', baseline: { name: 'WEB', group: 'prod', tags: ['web'] }, desired: { name: 'Renamed', group: 'prod', tags: ['web'] }, remote: { name: 'WEB', group: 'prod', tags: ['web'] }, status: 'pending', version: 1, attempts: 0, nextAttemptAt: 0, errorCode: null, conflicts: [], jobId: 'same-operation', updatedAt: 1 })
function remote(name = 'WEB') { return { uuid: 'node', created_at: '2026-01-01T00:00:00Z', name, group: 'prod', tags: 'web', token: 'must-never-be-persisted', ipv4: '192.0.2.1' } }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(vaultStatus).mockResolvedValue({ initialized: true, unlocked: true, secretCount: 1 }); vi.mocked(vaultGetSecret).mockResolvedValue('private-test-access') })

describe('native host metadata adapter', () => {
  it('uses the verified REST fields only and preserves actual node identity', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { data: { version: '1.6.0' } } : remote())))
    const result = await readRemoteHostMetadata({ endpoint: 'https://monitor.example', token: 'private-test-access' }, 'node', undefined, fetcher)
    expect(result).toEqual({ identity: 'node:2026-01-01T00:00:00Z', values: { name: 'WEB', group: 'prod', tags: ['web'] } })
    expect(JSON.stringify(result)).not.toContain('must-never')
    const row = binding()
    await writeRemoteHostMetadata({ endpoint: row.endpoint, token: 'private-test-access' }, row, undefined, fetcher)
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://monitor.example/api/admin/client/node/edit')
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ name: 'Renamed' })
    expect(metadataPatch({ ...row, desired: { ...row.remote } })).toEqual({})
  })
  it('refuses unsupported server contracts, missing identity and malformed responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: '2.0.0' })))
    await expect(readRemoteHostMetadata({ endpoint: 'https://monitor.example' }, 'node', undefined, fetcher)).rejects.toMatchObject({ code: 'endpoint-version' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const malformed of [{ ...remote(), uuid: 'other' }, { ...remote(), created_at: undefined }, { ...remote(), tags: ['wrong-type'] }]) {
      fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.6.0' }))).mockResolvedValueOnce(new Response(JSON.stringify(malformed)))
      await expect(readRemoteHostMetadata({ endpoint: 'https://monitor.example' }, 'node', undefined, fetcher)).rejects.toMatchObject({ code: 'invalid-response' })
    }
  })
})

describe('metadata worker', () => {
  function bridge(row: HostMetadataBinding, rejectSending = false) {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'host_metadata_session') return 7
      if (command === 'list_host_metadata_sync') return [structuredClone(row)]
      const input = (args as { input: { action: string; session: number; remote?: { values: HostMetadataBinding['desired'] } } }).input
      expect(input.session).toBe(7)
      if (input.action === 'sending' && rejectSending) throw new Error('METADATA_SCOPE_CHANGED')
      if (input.action === 'sending') row.status = 'applying'
      if (input.action === 'observe' && input.remote?.values.name === row.desired.name) row.status = 'synced'
      if (input.action === 'error') row.status = 'retry'
      row.version++
      return structuredClone(row)
    })
  }
  it('reads, claims durably, sends one patch and verifies before reporting a result', async () => {
    const row = binding(); bridge(row)
    let remoteName = 'WEB'
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/api/version')) return new Response(JSON.stringify({ version: '1.6.0' }))
      if (options?.method === 'POST') { expect(row.status).toBe('applying'); remoteName = 'Renamed'; return new Response(JSON.stringify({ status: 'success' })) }
      return new Response(JSON.stringify(remote(remoteName)))
    })
    vi.stubGlobal('fetch', fetcher)
    try {
      await syncHostMetadata('v', () => true)
      expect(row.status).toBe('synced')
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
      expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'host_metadata_sync_action').map(([, args]) => (args as { input: { action: string } }).input.action)).toEqual(['observe', 'sending', 'observe'])
      expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('private-test-access')
    } finally { vi.unstubAllGlobals() }
  })
  it('reconciles an interrupted write without replay when readback already matches', async () => {
    const row = { ...binding(), status: 'applying' as const }; bridge(row)
    const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '1.6.0' } : remote('Renamed'))))
    vi.stubGlobal('fetch', fetcher)
    try { await syncHostMetadata('v', () => true); expect(row.status).toBe('synced'); expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false) } finally { vi.unstubAllGlobals() }
  })
  it('does not dispatch after a binding change or an expired Vault generation', async () => {
    const row = binding(); bridge(row, true)
    const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '1.6.0' } : remote())))
    vi.stubGlobal('fetch', fetcher)
    try {
      await syncHostMetadata('v', () => true)
      expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
      let current = true
      vi.mocked(vaultGetSecret).mockImplementation(async () => { current = false; return 'private-test-access' })
      fetcher.mockClear(); await syncHostMetadata('v', () => current)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('leaves conflict, failed and disabled intents unwritten and uses native error codes only', async () => {
    const row = { ...binding(), status: 'conflict' as const }; bridge(row)
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('private-test-access server details') })
    vi.stubGlobal('fetch', fetcher)
    try {
      await syncHostMetadata('v', () => true)
      expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('private-test-access')
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('host_metadata_sync_action', { input: expect.objectContaining({ action: 'error', errorCode: 'unavailable' }) })
    } finally { vi.unstubAllGlobals() }
  })
  it('never dispatches when the native claim disables the binding or the Vault relocks and unlocks', async () => {
    for (const mode of ['disable', 'relock']) {
      const row = binding()
      let generation = 7
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'host_metadata_session') return generation
        if (command === 'list_host_metadata_sync') return [structuredClone(row)]
        const { action } = (args as { input: { action: string } }).input
        if (action === 'sending') {
          row.status = mode === 'disable' ? 'disabled' : 'applying'
          if (mode === 'relock') generation++
        }
        return structuredClone(row)
      })
      const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '1.6.0' } : remote())))
      vi.stubGlobal('fetch', fetcher)
      try {
        await syncHostMetadata('v', () => true)
        expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
      } finally { vi.unstubAllGlobals() }
    }
  })
  it('does not fetch or access secrets for stopped, exhausted or not-yet-due work', async () => {
    for (const row of [{ ...binding(), status: 'disabled' as const }, { ...binding(), status: 'failed' as const }, { ...binding(), nextAttemptAt: Date.now() + 60_000 }]) {
      bridge(row)
      vi.mocked(vaultGetSecret).mockClear()
      const fetcher = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetcher)
      try {
        await syncHostMetadata('v', () => true)
        expect(fetcher).not.toHaveBeenCalled()
        expect(vaultGetSecret).not.toHaveBeenCalled()
      } finally { vi.unstubAllGlobals() }
    }
  })
})
