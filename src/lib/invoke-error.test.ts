import { describe, expect, it } from 'vitest'
import { toInvokeErrorMessage } from './invoke-error'
import { parseHostKeyError } from '@/components/host-key-confirm-dialog'

describe('host identity errors through invoke', () => {
  it('preserves the fingerprint and exact hop for an explicit trust dialog', () => {
    const payload = JSON.stringify({ code: 'host_key_unknown', message: 'Unknown SSH key', host: 'jump.internal', port: 2222, fingerprint: 'sha-example', keyType: 'Ed25519', routeStage: 'jump' })
    expect(parseHostKeyError(toInvokeErrorMessage(payload))).toMatchObject({ host: 'jump.internal', port: 2222, fingerprint: 'sha-example' })
  })
})
