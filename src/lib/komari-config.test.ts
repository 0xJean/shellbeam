import { describe, expect, it } from 'vitest'
import {
  komariCredentialKey,
  normalizeKomariIntegrationInput,
} from './komari-config'

describe('Komari integration config', () => {
  it('keeps endpoint metadata separate from Vault credential references', () => {
    expect(normalizeKomariIntegrationInput({
      id: 'prod', vaultId: 'vault-a', name: 'Production Komari', endpoint: 'https://komari.example/', enabled: true,
    })).toEqual({
      id: 'prod', vaultId: 'vault-a', name: 'Production Komari', endpoint: 'https://komari.example',
      credentialRef: 'komari.prod.api-key', enabled: true,
    })
    expect(komariCredentialKey(' prod ')).toBe('komari.prod.api-key')
  })

  it('rejects missing vault/name and unsafe endpoints', () => {
    expect(() => normalizeKomariIntegrationInput({ vaultId: '', name: 'x', endpoint: 'https://x', enabled: true })).toThrow('vault id')
    expect(() => normalizeKomariIntegrationInput({ vaultId: 'v', name: '', endpoint: 'https://x', enabled: true })).toThrow('name')
    expect(() => normalizeKomariIntegrationInput({ vaultId: 'v', name: 'x', endpoint: 'https://u:p@x', enabled: true })).toThrow('credentials')
  })
})
