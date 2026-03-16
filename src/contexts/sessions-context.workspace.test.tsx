import { describe, expect, it } from 'vitest'
import type { SessionTab } from '@/lib/types'
import { getInitialWorkspaceSessionState } from '@/lib/workspace'
import {
  removeSessionWorkspaceState,
  setSessionWorkspaceAppState,
  setSessionWorkspaceModeState,
  syncSessionTabWorkspace,
} from './session-workspace-state'

describe('sessions workspace helpers', () => {
  const baseTab: SessionTab = {
    sessionId: 'session-1',
    hostName: 'Prod',
    hostAddress: '10.0.0.8',
    status: 'connected',
  }

  it('initializes a new session in terminal mode with overview selected', () => {
    expect(getInitialWorkspaceSessionState()).toEqual({
      mode: 'terminal',
      activeApp: 'overview',
    })
  })

  it('switches a session between terminal and workspace without affecting other sessions', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
      'session-2': getInitialWorkspaceSessionState(),
    }

    expect(setSessionWorkspaceModeState(state, 'session-1', 'workspace')).toEqual({
      'session-1': { mode: 'workspace', activeApp: 'overview' },
      'session-2': { mode: 'terminal', activeApp: 'overview' },
    })
  })

  it('remembers the active workspace app per session', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
    }

    expect(setSessionWorkspaceAppState(state, 'session-1', 'logs')).toEqual({
      'session-1': { mode: 'terminal', activeApp: 'logs' },
    })
  })

  it('removes workspace state when a session is closed', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
      'session-2': getInitialWorkspaceSessionState(),
    }

    expect(removeSessionWorkspaceState(state, 'session-1')).toEqual({
      'session-2': { mode: 'terminal', activeApp: 'overview' },
    })
  })

  it('mirrors workspace state into session tabs', () => {
    const state = {
      'session-1': { mode: 'workspace' as const, activeApp: 'logs' as const },
    }

    expect(syncSessionTabWorkspace([baseTab], state)).toEqual([
      { ...baseTab, mode: 'workspace', workspaceApp: 'logs' },
    ])
  })
})
