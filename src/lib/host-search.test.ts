import { describe, expect, it } from 'vitest'
import { matchesHostSearch } from './host-search'
import type { HostProfile } from './hosts'
const target: HostProfile = { id: 'target', vaultId: 'a', name: 'App', address: 'target.internal', port: 22, username: 'ops', authType: 'password', group: 'Production', tags: ['web'], createdAt: 1, updatedAt: 1, jumpHostId: 'jump', jumpHost: 'obsolete.internal', jumpUser: 'obsolete-user', jumpPort: 2201 }
const jump: HostProfile = { ...target, id: 'jump', name: 'Current Gateway', address: 'current.internal', username: 'current-user', port: 2299, jumpHostId: undefined, passwordKeyRef: 'credential-reference' }
describe('host search route resolution', () => {
  it('searches only same-Vault referenced jump metadata, without searching copied values or credential references', () => {
    for (const query of ['current gateway', 'CURRENT.INTERNAL', 'current-user', '2299']) expect(matchesHostSearch(target, query, [jump])).toBe(true)
    for (const query of ['obsolete.internal', 'obsolete-user', '2201', 'credential-reference']) expect(matchesHostSearch(target, query, [jump])).toBe(false)
    expect(matchesHostSearch(target, 'current.internal', [{ ...jump, vaultId: 'b' }])).toBe(false)
    expect(matchesHostSearch(target, 'obsolete.internal', [])).toBe(false)
  })
  it('retains legacy route and ordinary host search fields', () => {
    for (const query of ['App', 'target.internal', 'ops', 'production', 'web', '  ']) expect(matchesHostSearch(target, query, [])).toBe(true)
    const legacy = { ...target, jumpHostId: undefined }
    for (const query of ['obsolete.internal', 'obsolete-user', '2201']) expect(matchesHostSearch(legacy, query, [])).toBe(true)
  })
})
