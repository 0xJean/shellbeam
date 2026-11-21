import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteConversationThread,
  loadConversationBook,
  saveConversationThread,
} from './ai-conversation-store'
import type { AITurn } from './ai-conversation'
import { vaultOpenData, vaultSealData } from './vault'

const { defaultSeal, defaultOpen } = vi.hoisted(() => ({
  defaultSeal: async (_purpose: string, context: string, plaintext: string, vaultId?: string | null) =>
    `sealed:${btoa(encodeURIComponent(JSON.stringify([vaultId, context, plaintext])))}`,
  defaultOpen: async (_purpose: string, context: string, sealed: string, vaultId?: string | null) => {
    const [sealedVault, sealedContext, plaintext] = JSON.parse(
      decodeURIComponent(atob(sealed.slice('sealed:'.length))),
    ) as string[]
    if (sealedVault !== vaultId || sealedContext !== context) throw new Error('Vault seal mismatch')
    return plaintext
  },
}))

vi.mock('./vault', () => ({
  vaultSealData: vi.fn(defaultSeal),
  vaultOpenData: vi.fn(defaultOpen),
}))

const userTurn = (id: string, text: string): AITurn => ({ id, kind: 'user', text })

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(vaultSealData).mockImplementation(defaultSeal)
  vi.mocked(vaultOpenData).mockImplementation(defaultOpen)
})

describe('ai-conversation-store dual-terminal concurrency', () => {
  it('merges concurrent saves from two terminals on the same host without overwriting either thread', async () => {
    const key = 'v1:root@10.0.0.10'
    await saveConversationThread('v1', key, 'thread-0', [userTurn('u0', 'initial check')])

    // Simulate two terminals opening the same host and concurrently saving distinct threads
    // while seal operations complete asynchronously.
    let releaseFirstSeal!: () => void
    const firstSealGate = new Promise<void>((resolve) => { releaseFirstSeal = resolve })
    let sealCalls = 0
    vi.mocked(vaultSealData).mockImplementation(async (purpose, context, plaintext, vaultId) => {
      sealCalls += 1
      if (sealCalls === 1) await firstSealGate
      return defaultSeal(purpose, context, plaintext, vaultId)
    })

    const saveFromTerminalA = saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'check postgres slow sql')])
    const saveFromTerminalB = saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'check nginx 502 errors')])

    releaseFirstSeal()
    await Promise.all([saveFromTerminalA, saveFromTerminalB])

    const book = await loadConversationBook('v1', key)
    expect(book?.threads.map((t) => t.id)).toEqual(['thread-b', 'thread-a', 'thread-0'])
    expect(book?.threads.find((t) => t.id === 'thread-a')?.title).toBe('check postgres slow sql')
    expect(book?.threads.find((t) => t.id === 'thread-b')?.title).toBe('check nginx 502 errors')
  })

  it('preserves a sibling terminal thread when another terminal deletes an older thread', async () => {
    const key = 'v1:root@10.0.0.11'
    await saveConversationThread('v1', key, 'thread-0', [userTurn('u0', 'old session')])

    const saveA = saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'active investigation')])
    const deleteOldFromB = deleteConversationThread('v1', key, 'thread-0')
    await Promise.all([saveA, deleteOldFromB])

    const book = await loadConversationBook('v1', key)
    expect(book?.threads.map((t) => t.id)).toEqual(['thread-a'])
    expect(book?.activeId).toBe('thread-a')
  })

  it('does not clobber existing threads when another terminal saves a fresh empty thread, and only removes the cleared thread when explicitly cleared', async () => {
    const key = 'v1:root@10.0.0.12'
    await saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'disk full diagnosis')])

    // Opening a brand-new empty thread in Terminal B must not overwrite or drop thread-a.
    const unchanged = await saveConversationThread('v1', key, 'thread-b-empty', [])
    expect(unchanged?.threads.map((t) => t.id)).toEqual(['thread-a'])
    expect(unchanged?.activeId).toBe('thread-a')

    // Adding thread-b and then clearing thread-a removes only thread-a.
    await saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'redis memory check')])
    const afterClearA = await saveConversationThread('v1', key, 'thread-a', [])
    expect(afterClearA?.threads.map((t) => t.id)).toEqual(['thread-b'])
    expect(afterClearA?.activeId).toBe('thread-b')
  })

  it('aborts queued writes instead of wiping sealed history when the Vault cannot open existing data', async () => {
    const key = 'v1:root@10.0.0.13'
    await saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'important incident log')])
    const beforeRaw = localStorage.getItem(`shellbeam.aiConversationSealed.${key}`)
    expect(beforeRaw).toBeTruthy()

    vi.mocked(vaultOpenData).mockRejectedValueOnce(new Error('Vault is locked'))
    const result = await saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'should abort')])
    expect(result).toBeUndefined()
    expect(localStorage.getItem(`shellbeam.aiConversationSealed.${key}`)).toBe(beforeRaw)

    // Once unlocked again, the original history is intact.
    const book = await loadConversationBook('v1', key)
    expect(book?.threads.map((t) => t.id)).toEqual(['thread-a'])
  })
})
