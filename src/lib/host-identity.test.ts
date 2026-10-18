import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import { getHostIdentity } from './host-identity'

const target: HostProfile = { id: 'target', name: 'target', address: 'target.internal', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1, jumpHostId: 'jump', jumpHost: 'old.internal', jumpPort: 22, jumpUser: 'old-user' }
const jump: HostProfile = { ...target, id: 'jump', name: 'Edited jump', address: 'new.internal', port: 2200, username: 'new-user', jumpHostId: undefined, jumpHost: undefined, passwordKeyRef: 'never-expose-ref' }
describe('safe host route identity', () => {
  it('uses the edited referenced profile instead of copied legacy jump fields', () => {
    const identity = getHostIdentity(target, [target, jump])
    expect(identity.jump).toEqual({ hostId: 'jump', address: 'new.internal', port: 2200, username: 'new-user' })
    expect(JSON.stringify(identity)).not.toMatch(/old.internal|old-user|never-expose-ref/)
  })
  it('keeps unresolved references partial while retaining legacy direct configurations', () => {
    expect(getHostIdentity(target).jump).toEqual({ hostId: 'jump' })
    expect(getHostIdentity({ ...target, jumpHostId: undefined }).jump).toEqual({ address: 'old.internal', port: 22, username: 'old-user' })
  })
})
