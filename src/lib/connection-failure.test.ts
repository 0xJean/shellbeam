import { describe, expect, it } from 'vitest'
import { parseConnectFailure } from './connection-failure'

describe('parseConnectFailure', () => {
  it('maps backend stage/operation errors to the failed step', () => {
    expect(parseConnectFailure('SSH target handshake_failed')).toMatchObject({ stage: 'secure_session', completed: ['resolve_host', 'open_tcp'], viaJump: false })
    expect(parseConnectFailure('SSH jump auth_failed')).toMatchObject({ stage: 'authenticate', viaJump: true })
    expect(parseConnectFailure('SSH target unreachable')).toMatchObject({ stage: 'open_tcp', completed: [] })
    expect(parseConnectFailure('interactive start shell failed: boom')).toMatchObject({ stage: 'prepare_workspace' })
    expect(parseConnectFailure('Connection cancelled: host key not accepted')).toMatchObject({ stage: 'verify_host', reason: 'host_key_rejected' })
    expect(parseConnectFailure(JSON.stringify({ code: 'host_key_mismatch', host: 'h', port: 22, fingerprint: 'f', routeStage: 'jump' }))).toMatchObject({ stage: 'verify_host', viaJump: true, hostKeyMismatch: true })
  })

  it('returns null for errors without a stage', () => {
    expect(parseConnectFailure(undefined)).toBeNull()
    expect(parseConnectFailure('VAULT_LOCKED')).toBeNull()
  })
})
