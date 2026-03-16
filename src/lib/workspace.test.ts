import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_MODE,
  getInitialWorkspaceSessionState,
  isWorkspaceApp,
} from './workspace'

describe('workspace helpers', () => {
  it('returns terminal as the default session mode', () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe('terminal')
  })

  it('creates a fresh session workspace state', () => {
    expect(getInitialWorkspaceSessionState()).toEqual({
      mode: 'terminal',
      activeApp: 'overview',
    })
  })

  it('validates known workspace apps', () => {
    expect(isWorkspaceApp('logs')).toBe(true)
    expect(isWorkspaceApp('bogus')).toBe(false)
  })
})
