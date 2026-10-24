import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_MODE,
  getInitialWorkspaceSessionState,
  isWorkspaceApp,
  normalizeWorkspaceApp,
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
    expect(isWorkspaceApp('network')).toBe(true)
    expect(isWorkspaceApp('fileTransfer')).toBe(true)
    expect(isWorkspaceApp('fileSystem')).toBe(true)
    expect(isWorkspaceApp('assetInventory')).toBe(true)
    expect(isWorkspaceApp('toolManager')).toBe(true)
    expect(isWorkspaceApp('bogus')).toBe(false)
  })

  it('maps legacy files app ids to file transfer', () => {
    expect(normalizeWorkspaceApp('files')).toBe('fileTransfer')
    expect(normalizeWorkspaceApp('fileTransfer')).toBe('fileTransfer')
    expect(normalizeWorkspaceApp('fileSystem')).toBe('fileSystem')
    expect(normalizeWorkspaceApp('network')).toBe('network')
    expect(normalizeWorkspaceApp('assetInventory')).toBe('assetInventory')
    expect(normalizeWorkspaceApp('toolManager')).toBe('toolManager')
    expect(normalizeWorkspaceApp('bogus')).toBe('overview')
  })
})
