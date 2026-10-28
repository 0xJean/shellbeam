import { describe, expect, it } from 'vitest'
import type { HostProfile } from './hosts'
import { getServerConsoleLink } from './server-console'

function host(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    id: 'host-1',
    name: 'Server',
    address: '154.26.133.131',
    port: 22,
    username: 'root',
    group: 'Production',
    authType: 'password',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('server console links', () => {
  it('detects a provider console from host tags', () => {
    expect(getServerConsoleLink(host({ tags: ['Contabo'] }))).toEqual({
      label: 'Contabo',
      url: 'https://my.contabo.com/account/login',
      source: 'provider',
    })
  })

  it('prefers an explicit console tag over provider detection', () => {
    expect(getServerConsoleLink(host({ tags: ['Contabo', 'console:https://example.com/server/123'] }))).toEqual({
      label: 'Server',
      url: 'https://example.com/server/123',
      source: 'tag',
    })
  })

  it('returns null when no console metadata is known', () => {
    expect(getServerConsoleLink(host({ tags: ['api'] }))).toBeNull()
  })
})
