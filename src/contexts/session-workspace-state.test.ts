import { describe, expect, it } from 'vitest'
import { setSessionWorkspaceAppState } from './session-workspace-state'

describe('workspace Terminal handoff', () => {
  it('returns to the same terminal while retaining the current diagnostic app', () => {
    const next = setSessionWorkspaceAppState({ current: { mode: 'workspace', activeApp: 'processes' } }, 'current', 'terminal')
    expect(next.current).toMatchObject({ mode: 'terminal', activeApp: 'processes' })
  })
})
