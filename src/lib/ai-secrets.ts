import { vaultDeleteSecret, vaultGetSecret, vaultSetSecret } from './vault'

/**
 * Model API keys live in the unlocked Vault, one secret per provider, and are
 * held in memory only while that Vault is unlocked. AI settings in the
 * webview's storage keep everything else.
 *
 * Older releases kept the keys in plain text with the settings. Until a Vault
 * has been unlocked once after upgrading, those keys stay where they are so
 * nothing is lost; the first unlock moves them into the Vault and removes them
 * from storage for good.
 */

export const AI_KEY_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'custom'] as const
export type AIKeyProvider = typeof AI_KEY_PROVIDERS[number]

/** Set once keys have moved into a Vault; from then on keys are never written to storage again. */
export const AI_KEYS_IN_VAULT_FLAG = 'shellbeam.aiKeysInVault'
const PERSIST_DELAY_MS = 400

export const aiKeySecretName = (provider: AIKeyProvider) => `ai.${provider}.api-key`
export const isAIKeyProvider = (value: string): value is AIKeyProvider => (AI_KEY_PROVIDERS as readonly string[]).includes(value)

const keys = new Map<AIKeyProvider, string>()
/** Keys changed in this session that the Vault has not stored yet. */
const dirty = new Set<AIKeyProvider>()
let vaultId: string | null = null
let generation = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistChain: Promise<void> = Promise.resolve()

function readFlag(): boolean {
  try { return localStorage.getItem(AI_KEYS_IN_VAULT_FLAG) === '1' } catch { return false }
}

/** Whether settings may still carry keys in storage: only until a Vault has stored every one of them. */
export function aiKeysMayLiveInStorage(): boolean {
  return !readFlag()
}

let onSecured: (() => void) | null = null
/** Called once every key is in a Vault, so the settings can drop their plain-text copies. */
export function onAIKeysSecured(handler: () => void) {
  onSecured = handler
}

function markSecured() {
  if (!readFlag()) {
    try { localStorage.setItem(AI_KEYS_IN_VAULT_FLAG, '1') } catch { return }
  }
  onSecured?.()
}

/** The key this session knows for a provider, or undefined when it has none. */
export function cachedAIKey(provider: AIKeyProvider): string | undefined {
  return keys.get(provider)
}

/** Record keys the user typed (or that older settings still held). The Vault stores them shortly after. */
export function rememberAIKeys(next: Partial<Record<AIKeyProvider, string>>) {
  let changed = false
  for (const provider of AI_KEY_PROVIDERS) {
    if (!(provider in next)) continue
    const value = next[provider] ?? ''
    if (keys.get(provider) === value) continue
    keys.set(provider, value)
    dirty.add(provider)
    changed = true
  }
  if (changed && vaultId) schedulePersist()
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => { persistTimer = null; void flushAIKeys() }, PERSIST_DELAY_MS)
}

/** Writes every changed key to the Vault now. Resolves once the writes are done; failures stay pending. */
export function flushAIKeys(): Promise<void> {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  const target = vaultId
  const scope = generation
  persistChain = persistChain.then(async () => {
    if (!target || scope !== generation) return
    for (const provider of [...dirty]) {
      const value = keys.get(provider) ?? ''
      try {
        if (value) await vaultSetSecret(aiKeySecretName(provider), value, target)
        else await vaultDeleteSecret(aiKeySecretName(provider), target)
        // A newer edit made while writing stays dirty for the next flush.
        if (scope === generation && (keys.get(provider) ?? '') === value) dirty.delete(provider)
      } catch { /* the Vault locked or failed; the key stays pending */ }
    }
    if (scope === generation && dirty.size === 0) markSecured()
  })
  return persistChain
}

/**
 * Load the keys of a Vault that just unlocked. Keys the user entered before it
 * did (or that older settings still held in storage) are written into it;
 * every other provider takes the Vault's value.
 */
export async function hydrateAIKeys(nextVaultId: string, legacy: Partial<Record<AIKeyProvider, string>> = {}): Promise<void> {
  const scope = ++generation
  vaultId = nextVaultId
  const stored = await Promise.all(AI_KEY_PROVIDERS.map(async (provider) => {
    try { return [provider, await vaultGetSecret(aiKeySecretName(provider), nextVaultId)] as const }
    catch { return [provider, undefined] as const }
  }))
  if (scope !== generation) return
  for (const [provider, value] of stored) {
    // A key typed before the unlock is newer than the Vault's.
    if (dirty.has(provider)) continue
    if (value) keys.set(provider, value)
    // The Vault has none: a key an older release kept in storage moves in.
    else if (legacy[provider]) { keys.set(provider, legacy[provider]!); dirty.add(provider) }
    else keys.delete(provider)
  }
  await flushAIKeys()
}

/** The Vault locked or changed: forget every key this session held. */
export function clearAIKeys() {
  generation += 1
  vaultId = null
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  keys.clear()
  dirty.clear()
}

/** For tests: forget everything this session held. */
export function resetAIKeysForTests() {
  generation += 1
  vaultId = null
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  keys.clear()
  dirty.clear()
  persistChain = Promise.resolve()
}
