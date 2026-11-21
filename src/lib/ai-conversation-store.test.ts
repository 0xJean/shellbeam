import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteConversationThread,
  loadConversationBook,
  loadConversationBookState,
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
const aiTurn = (id: string, text: string): AITurn => ({ id, kind: 'ai', text, model: 'codex' })

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

    let releaseFirstSeal!: () => void
    const firstSealGate = new Promise<void>((resolve) => { releaseFirstSeal = resolve })
    let sealCalls = 0
    vi.mocked(vaultSealData).mockImplementation(async (purpose, context, plaintext, vaultId) => {
      sealCalls += 1
      if (sealCalls === 1) await firstSealGate
      return defaultSeal(purpose, context, plaintext, vaultId)
    })

    const saveFromTerminalA = saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'check postgres slow sql')], { clientId: 'panel-a' })
    const saveFromTerminalB = saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'check nginx 502 errors')], { clientId: 'panel-b' })

    releaseFirstSeal()
    await Promise.all([saveFromTerminalA, saveFromTerminalB])

    const book = await loadConversationBook('v1', key)
    expect(book?.threads.map((t) => t.id)).toEqual(['thread-b', 'thread-a', 'thread-0'])
    expect(book?.threads.find((t) => t.id === 'thread-a')?.title).toBe('check postgres slow sql')
    expect(book?.threads.find((t) => t.id === 'thread-b')?.title).toBe('check nginx 502 errors')
  })

  it('forks when two terminals diverge on the same shared thread and keeps rapid follow-ups in the same fork', async () => {
    const key = 'v1:root@10.0.0.14'
    const baseTurns: AITurn[] = [userTurn('u1', 'check db load'), aiTurn('a1', '# Load is normal.')]
    const initial = await saveConversationThread('v1', key, 'thread-1', baseTurns, { expectedRevision: 0, clientId: 'panel-a' })
    expect(initial?.revision).toBe(1)

    // Panel A appends follow-up A and reply A (revision 2 & 3 on thread-1).
    const a1 = await saveConversationThread('v1', key, 'thread-1', [...baseTurns, userTurn('ua', 'check connections')], { expectedRevision: 1, clientId: 'panel-a' })
    const a2 = await saveConversationThread('v1', key, 'thread-1', [...baseTurns, userTurn('ua', 'check connections'), aiTurn('aa', '# 42 active.')], { expectedRevision: 1, clientId: 'panel-a' })
    expect(a1?.forked).toBe(false)
    expect(a2?.forked).toBe(false)
    expect(a2?.threadId).toBe('thread-1')

    // Panel B still holds expectedRevision: 1 and submits follow-up B + reply B rapidly.
    const [b1, b2] = await Promise.all([
      saveConversationThread('v1', key, 'thread-1', [...baseTurns, userTurn('ub', 'check slow queries')], { expectedRevision: 1, clientId: 'panel-b' }),
      saveConversationThread('v1', key, 'thread-1', [...baseTurns, userTurn('ub', 'check slow queries'), aiTurn('ab', '# 3 slow queries.')], { expectedRevision: 1, clientId: 'panel-b' }),
    ])
    expect(b1?.forked).toBe(true)
    expect(b2?.forked).toBe(true)
    expect(b2?.threadId).toBe(b1?.threadId)
    expect(b1?.threadId).not.toBe('thread-1')

    const book = await loadConversationBook('v1', key)
    expect(book?.threads).toHaveLength(2)
    const threadA = book?.threads.find((t) => t.id === 'thread-1')
    const threadB = book?.threads.find((t) => t.id === b1?.threadId)
    expect(threadA?.turns.map((t) => t.kind === 'user' || t.kind === 'ai' ? t.text : '')).toContain('# 42 active.')
    expect(threadB?.turns.map((t) => t.kind === 'user' || t.kind === 'ai' ? t.text : '')).toContain('# 3 slow queries.')
  })

  it('prevents a stale clear from wiping newer replies added by a sibling terminal', async () => {
    const key = 'v1:root@10.0.0.15'
    await saveConversationThread('v1', key, 'thread-1', [userTurn('u1', 'first')], { expectedRevision: 0, clientId: 'panel-a' })
    await saveConversationThread('v1', key, 'thread-1', [userTurn('u1', 'first'), userTurn('u2', 'second')], { expectedRevision: 1, clientId: 'panel-a' })

    // Panel B (still at revision 1) clears; Panel A's revision 2 must survive.
    await saveConversationThread('v1', key, 'thread-1', [], { expectedRevision: 1, clientId: 'panel-b' })
    const book = await loadConversationBook('v1', key)
    expect(book?.threads).toHaveLength(1)
    expect(book?.threads[0].turns).toHaveLength(2)
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

    const unchanged = await saveConversationThread('v1', key, 'thread-b-empty', [])
    expect(unchanged?.book?.threads.map((t) => t.id)).toEqual(['thread-a'])
    expect(unchanged?.book?.activeId).toBe('thread-a')

    await saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'redis memory check')])
    const afterClearA = await saveConversationThread('v1', key, 'thread-a', [])
    expect(afterClearA?.book?.threads.map((t) => t.id)).toEqual(['thread-b'])
    expect(afterClearA?.book?.activeId).toBe('thread-b')
  })

  it('distinguishes confirmed empty books from Vault read errors and never wipes sealed history on lock', async () => {
    const key = 'v1:root@10.0.0.13'
    expect(await loadConversationBookState('v1', key)).toEqual({ status: 'empty' })

    await saveConversationThread('v1', key, 'thread-a', [userTurn('ua', 'important incident log')])
    const beforeRaw = localStorage.getItem(`shellbeam.aiConversationSealed.${key}`)
    expect(beforeRaw).toBeTruthy()

    vi.mocked(vaultOpenData).mockRejectedValueOnce(new Error('Vault is locked'))
    expect(await loadConversationBookState('v1', key)).toEqual({ status: 'error' })

    vi.mocked(vaultOpenData).mockRejectedValueOnce(new Error('Vault is locked'))
    const result = await saveConversationThread('v1', key, 'thread-b', [userTurn('ub', 'should abort')])
    expect(result).toBeUndefined()
    expect(localStorage.getItem(`shellbeam.aiConversationSealed.${key}`)).toBe(beforeRaw)

    const ok = await loadConversationBookState('v1', key)
    expect(ok.status).toBe('ok')
    if (ok.status === 'ok') expect(ok.book.threads.map((t) => t.id)).toEqual(['thread-a'])

    await deleteConversationThread('v1', key, 'thread-a')
    expect(await loadConversationBookState('v1', key)).toEqual({ status: 'empty' })
  })
})
