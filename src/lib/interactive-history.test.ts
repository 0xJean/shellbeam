import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearInteractiveHistory, flushInteractiveHistory, getInteractiveHistory, hydrateInteractiveHistory, isInteractiveHistoryEvent,
  recordInteractiveCommand, resetInteractiveHistoryCacheForTests,
} from './interactive-history'
import { vaultOpenData, vaultSealData } from './vault'

const unlocked = new Set<string>()
vi.mock('./vault', () => ({
  // A reversible stand-in for the Vault seal: opaque text, bound to its Vault and context.
  vaultSealData: vi.fn(async (_purpose: string, context: string, plaintext: string, vaultId?: string | null) => {
    if (!unlocked.has(vaultId ?? '')) throw new Error('Vault is locked')
    return `sealed:${btoa(encodeURIComponent(JSON.stringify([vaultId, context, plaintext])))}`
  }),
  vaultOpenData: vi.fn(async (_purpose: string, context: string, sealed: string, vaultId?: string | null) => {
    if (!unlocked.has(vaultId ?? '')) throw new Error('Vault is locked')
    const [sealedVault, sealedContext, plaintext] = JSON.parse(decodeURIComponent(atob(sealed.slice('sealed:'.length)))) as string[]
    if (sealedVault !== vaultId || sealedContext !== context) throw new Error('does not open')
    return plaintext
  }),
}))

const LEGACY_KEY = 'shellbeam.interactiveHistory'
const SEALED_KEY = 'shellbeam.interactiveHistorySealed'
const commands = (vaultId: string | undefined, host = '10.0.0.1') => getInteractiveHistory(vaultId, host).map((entry) => entry.command)

describe('interactive history', () => {
  beforeEach(() => {
    localStorage.clear()
    unlocked.clear()
    resetInteractiveHistoryCacheForTests()
    vi.clearAllMocks()
  })

  it('keeps typed commands separate per vault', () => {
    recordInteractiveCommand('vault-a', '10.0.0.1', 'uptime')
    recordInteractiveCommand('vault-b', '10.0.0.1', 'whoami')
    expect(commands('vault-a')).toEqual(['uptime'])
    expect(commands('vault-b')).toEqual(['whoami'])
    expect(commands(undefined)).toEqual([])
  })

  it('stores history only sealed by its Vault, and reads it back after unlock', async () => {
    unlocked.add('vault-a')
    await hydrateInteractiveHistory('vault-a')
    recordInteractiveCommand('vault-a', '10.0.0.1', 'mysql -uroot -phunter2')
    await flushInteractiveHistory()
    const stored = localStorage.getItem(`${SEALED_KEY}:vault-a`)!
    expect(stored).toMatch(/^sealed:/)
    expect(Object.values(localStorage).join('\n')).not.toContain('hunter2')

    clearInteractiveHistory()
    expect(commands('vault-a')).toEqual([])
    await hydrateInteractiveHistory('vault-a')
    expect(commands('vault-a')).toEqual(['mysql -uroot -phunter2'])
  })

  it('writes nothing while the Vault is locked and keeps the commands for when it unlocks', async () => {
    recordInteractiveCommand('vault-a', '10.0.0.1', 'uptime')
    await flushInteractiveHistory()
    expect(vaultSealData).not.toHaveBeenCalled()
    expect(Object.keys(localStorage)).toEqual([])
    unlocked.add('vault-a')
    await hydrateInteractiveHistory('vault-a')
    expect(commands('vault-a')).toEqual(['uptime'])
    expect(localStorage.getItem(`${SEALED_KEY}:vault-a`)).toMatch(/^sealed:/)
  })

  it('seals plain text from older releases, including the unscoped history that belongs to Personal', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ '10.0.0.1': [{ command: 'ls', timestamp: 1 }] }))
    localStorage.setItem(`${LEGACY_KEY}:personal`, JSON.stringify({ '10.0.0.1': [{ command: 'pwd', timestamp: 2 }] }))
    localStorage.setItem(`${LEGACY_KEY}:vault-b`, JSON.stringify({ '10.0.0.1': [{ command: 'id', timestamp: 3 }] }))
    unlocked.add('personal')
    await hydrateInteractiveHistory(undefined)

    expect(commands(undefined)).toEqual(['ls', 'pwd'])
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(`${LEGACY_KEY}:personal`)).toBeNull()
    expect(localStorage.getItem(`${SEALED_KEY}:personal`)).toMatch(/^sealed:/)
    // Another Vault's plain text waits for that Vault.
    expect(localStorage.getItem(`${LEGACY_KEY}:vault-b`)).not.toBeNull()

    resetInteractiveHistoryCacheForTests()
    await hydrateInteractiveHistory('personal')
    expect(commands('personal')).toEqual(['ls', 'pwd'])
  })

  it('keeps plain text where it is when the Vault cannot seal it', async () => {
    localStorage.setItem(`${LEGACY_KEY}:vault-a`, JSON.stringify({ '10.0.0.1': [{ command: 'ls', timestamp: 1 }] }))
    await hydrateInteractiveHistory('vault-a')
    expect(localStorage.getItem(`${LEGACY_KEY}:vault-a`)).not.toBeNull()
  })

  it('leaves a sealed history it cannot open untouched', async () => {
    unlocked.add('vault-a')
    await hydrateInteractiveHistory('vault-a')
    recordInteractiveCommand('vault-a', '10.0.0.1', 'uptime')
    await flushInteractiveHistory()
    const stored = localStorage.getItem(`${SEALED_KEY}:vault-a`)
    resetInteractiveHistoryCacheForTests()
    unlocked.clear()
    await hydrateInteractiveHistory('vault-a')
    expect(vaultOpenData).toHaveBeenCalled()
    expect(localStorage.getItem(`${SEALED_KEY}:vault-a`)).toBe(stored)
  })

  it('tells every host of a Vault when its history loads', () => {
    expect(isInteractiveHistoryEvent('vault-a', '10.0.0.1', 'vault-a', '')).toBe(true)
    expect(isInteractiveHistoryEvent('vault-a', '10.0.0.1', 'vault-a', '10.0.0.2')).toBe(false)
    expect(isInteractiveHistoryEvent('vault-a', '10.0.0.1', 'vault-b', '')).toBe(false)
  })
})
