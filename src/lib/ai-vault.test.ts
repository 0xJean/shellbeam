import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, loadAISettings, saveAISettings, type AISettings } from './ai'
import { flushAIKeys, resetAIKeysForTests, AI_KEYS_IN_VAULT_FLAG } from './ai-secrets'
import { onAIVaultLocked, onAIVaultUnlocked } from './ai-vault'
import { vaultDeleteSecret, vaultSealData, vaultSetSecret } from './vault'

const vaults = new Map<string, Map<string, string>>()
const secretsOf = (vaultId?: string | null) => {
  const id = vaultId ?? 'default'
  if (!vaults.has(id)) vaults.set(id, new Map())
  return vaults.get(id)!
}

vi.mock('./vault', () => ({
  vaultGetSecret: vi.fn(async (key: string, vaultId?: string | null) => secretsOf(vaultId).get(key) ?? null),
  vaultSetSecret: vi.fn(async (key: string, value: string, vaultId?: string | null) => { secretsOf(vaultId).set(key, value) }),
  vaultDeleteSecret: vi.fn(async (key: string, vaultId?: string | null) => { secretsOf(vaultId).delete(key) }),
  vaultSealData: vi.fn(async (_purpose: string, context: string, plaintext: string, vaultId?: string | null) => `sealed:${btoa(encodeURIComponent(JSON.stringify([vaultId, context, plaintext])))}`),
  vaultOpenData: vi.fn(async () => { throw new Error('not used') }),
}))

const SETTINGS = 'shellbeam.aiSettings'
const stored = () => JSON.parse(localStorage.getItem(SETTINGS) ?? 'null') as AISettings | null
const legacy: AISettings = {
  ...DEFAULT_AI_SETTINGS, provider: 'openai', apiKey: 'sk-openai-legacy',
  providerProfiles: { anthropic: { apiKey: 'sk-ant-legacy', model: 'claude' } },
}

beforeEach(() => {
  localStorage.clear()
  vaults.clear()
  resetAIKeysForTests()
  vi.clearAllMocks()
})

describe('AI keys in the Vault', () => {
  it('leaves keys from an older release in place until a Vault has taken them', () => {
    localStorage.setItem(SETTINGS, JSON.stringify(legacy))
    expect(loadAISettings().apiKey).toBe('sk-openai-legacy')
    saveAISettings({ ...loadAISettings(), model: 'gpt-4o' })
    expect(stored()?.apiKey).toBe('sk-openai-legacy')
    expect(vaultSetSecret).not.toHaveBeenCalled()
  })

  it('moves keys into the Vault on unlock and removes them from storage', async () => {
    localStorage.setItem(SETTINGS, JSON.stringify(legacy))
    await onAIVaultUnlocked('v1')
    expect(secretsOf('v1').get('ai.openai.api-key')).toBe('sk-openai-legacy')
    expect(secretsOf('v1').get('ai.anthropic.api-key')).toBe('sk-ant-legacy')
    const raw = localStorage.getItem(SETTINGS)!
    expect(raw).not.toContain('sk-openai-legacy')
    expect(raw).not.toContain('sk-ant-legacy')
    expect(localStorage.getItem(AI_KEYS_IN_VAULT_FLAG)).toBe('1')
    const loaded = loadAISettings()
    expect(loaded.apiKey).toBe('sk-openai-legacy')
    expect(loaded.providerProfiles?.anthropic?.apiKey).toBe('sk-ant-legacy')
  })

  it('stores a new key only in the Vault, and clears it from the Vault when emptied', async () => {
    await onAIVaultUnlocked('v1')
    saveAISettings({ ...loadAISettings(), apiKey: 'sk-new' })
    expect(localStorage.getItem(SETTINGS)).not.toContain('sk-new')
    expect(loadAISettings().apiKey).toBe('sk-new')
    await flushAIKeys()
    expect(secretsOf('v1').get('ai.openai.api-key')).toBe('sk-new')
    saveAISettings({ ...loadAISettings(), apiKey: '' })
    await flushAIKeys()
    expect(vaultDeleteSecret).toHaveBeenCalledWith('ai.openai.api-key', 'v1')
    expect(secretsOf('v1').has('ai.openai.api-key')).toBe(false)
  })

  it('forgets keys on lock and never writes them back to storage while locked', async () => {
    secretsOf('v1').set('ai.openai.api-key', 'sk-vault')
    await onAIVaultUnlocked('v1')
    expect(loadAISettings().apiKey).toBe('sk-vault')
    onAIVaultLocked()
    expect(loadAISettings().apiKey).toBe('')
    saveAISettings({ ...loadAISettings(), apiKey: 'sk-typed-while-locked' })
    expect(localStorage.getItem(SETTINGS)).not.toContain('sk-typed-while-locked')
  })

  it('takes each Vault’s own keys when another Vault unlocks', async () => {
    secretsOf('v1').set('ai.openai.api-key', 'sk-one')
    secretsOf('v2').set('ai.openai.api-key', 'sk-two')
    await onAIVaultUnlocked('v1')
    expect(loadAISettings().apiKey).toBe('sk-one')
    onAIVaultLocked()
    await onAIVaultUnlocked('v2')
    expect(loadAISettings().apiKey).toBe('sk-two')
    expect(secretsOf('v1').get('ai.openai.api-key')).toBe('sk-one')
  })

  it('keeps a key the Vault already holds over an old plain-text one', async () => {
    secretsOf('v1').set('ai.openai.api-key', 'sk-vault')
    localStorage.setItem(SETTINGS, JSON.stringify(legacy))
    await onAIVaultUnlocked('v1')
    expect(loadAISettings().apiKey).toBe('sk-vault')
    expect(secretsOf('v1').get('ai.anthropic.api-key')).toBe('sk-ant-legacy')
    expect(localStorage.getItem(SETTINGS)).not.toContain('legacy')
  })

  it('keeps the old keys where they were when the Vault cannot store them', async () => {
    localStorage.setItem(SETTINGS, JSON.stringify(legacy))
    vi.mocked(vaultSetSecret).mockRejectedValue(new Error('Vault is locked'))
    await onAIVaultUnlocked('v1')
    expect(localStorage.getItem(SETTINGS)).toContain('sk-openai-legacy')
    expect(localStorage.getItem(AI_KEYS_IN_VAULT_FLAG)).toBeNull()
  })
})

describe('AI conversations from an older release', () => {
  it('seals this Vault’s conversations, drops ones kept without a Vault, and leaves other Vaults’ alone', async () => {
    const conversation = JSON.stringify({ savedAt: 1, turns: [{ id: 'u', kind: 'user', text: 'cat /etc/shadow' }] })
    localStorage.setItem('shellbeam.aiConversation.v1:root@a', conversation)
    localStorage.setItem('shellbeam.aiConversation.none:root@b', conversation)
    localStorage.setItem('shellbeam.aiConversation.v2:root@c', conversation)
    await onAIVaultUnlocked('v1')
    expect(localStorage.getItem('shellbeam.aiConversation.v1:root@a')).toBeNull()
    expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@a')).toMatch(/^sealed:/)
    expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@a')).not.toContain('shadow')
    expect(vaultSealData).toHaveBeenCalledWith('ai.conversation', 'v1:root@a', conversation, 'v1')
    expect(localStorage.getItem('shellbeam.aiConversation.none:root@b')).toBeNull()
    expect(localStorage.getItem('shellbeam.aiConversation.v2:root@c')).toBe(conversation)
  })
})
