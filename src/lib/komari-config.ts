import { invoke } from '@tauri-apps/api/core'
import { normalizeKomariEndpoint } from './komari'

export const KOMARI_CREDENTIAL_PREFIX = 'komari.'

export interface KomariIntegration {
  id: string
  vaultId: string
  name: string
  endpoint: string
  credentialRef: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface KomariIntegrationInput {
  id?: string
  vaultId: string
  name: string
  endpoint: string
  credentialRef?: string
  enabled: boolean
}

export function komariCredentialKey(integrationId: string): string {
  const id = integrationId.trim()
  if (!id) throw new Error('Komari integration id is required')
  return `${KOMARI_CREDENTIAL_PREFIX}${id}.api-key`
}

export function normalizeKomariIntegrationInput(input: KomariIntegrationInput) {
  const vaultId = input.vaultId.trim()
  const name = input.name.trim()
  if (!vaultId) throw new Error('Komari vault id is required')
  if (!name) throw new Error('Komari integration name is required')
  const endpoint = normalizeKomariEndpoint(input.endpoint)
  const id = input.id?.trim() || undefined
  return {
    ...(id ? { id } : {}),
    vaultId,
    name,
    endpoint,
    credentialRef: input.credentialRef?.trim() || (id ? komariCredentialKey(id) : 'komari.pending.api-key'),
    enabled: input.enabled,
  }
}

export async function listKomariIntegrations(vaultId: string): Promise<KomariIntegration[]> {
  return invoke<KomariIntegration[]>('list_komari_integrations', { vaultId: vaultId.trim() })
}

export async function upsertKomariIntegration(input: KomariIntegrationInput): Promise<KomariIntegration> {
  return invoke<KomariIntegration>('upsert_komari_integration', {
    input: normalizeKomariIntegrationInput(input),
  })
}

export async function deleteKomariIntegration(id: string, vaultId: string): Promise<void> {
  return invoke<void>('delete_komari_integration', { id: id.trim(), vaultId: vaultId.trim() })
}
