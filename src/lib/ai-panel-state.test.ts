import { beforeEach, describe, expect, it } from 'vitest'
import { aiPanelHostKey, readHostAiPanelOpen, writeHostAiPanelOpen } from './ai-panel-state'

describe('ai-panel-state', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefers vault+hostId over address for saved servers and falls back to address', () => {
    expect(aiPanelHostKey({ vaultId: 'work', hostId: 'h-1', username: 'root', hostAddress: '10.0.0.1' }))
      .toBe('work:host:h-1')
    expect(aiPanelHostKey({ vaultId: 'work', hostId: null, username: 'ops', hostAddress: '10.0.0.2' }))
      .toBe('work:addr:ops@10.0.0.2')
    expect(aiPanelHostKey({ vaultId: 'personal', hostId: 'local', username: 'jean', hostAddress: 'local' }))
      .toBe('personal:addr:jean@local')
    expect(aiPanelHostKey({})).toBeNull()
  })

  it('persists open/closed state independently per server and defaults to false', () => {
    const hostA = aiPanelHostKey({ vaultId: 'v1', hostId: 'srv-a', hostAddress: '10.0.0.1' })
    const hostB = aiPanelHostKey({ vaultId: 'v1', hostId: 'srv-b', hostAddress: '10.0.0.2' })

    expect(readHostAiPanelOpen(hostA)).toBe(false)
    expect(readHostAiPanelOpen(hostB)).toBe(false)

    writeHostAiPanelOpen(hostA, true)
    expect(readHostAiPanelOpen(hostA)).toBe(true)
    expect(readHostAiPanelOpen(hostB)).toBe(false)

    writeHostAiPanelOpen(hostB, true)
    writeHostAiPanelOpen(hostA, false)
    expect(readHostAiPanelOpen(hostA)).toBe(false)
    expect(readHostAiPanelOpen(hostB)).toBe(true)
  })
})
