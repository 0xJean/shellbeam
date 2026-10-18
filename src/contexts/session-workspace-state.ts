import type { SessionTab } from '@/lib/types'
import {
  getInitialWorkspaceSessionState,
  normalizeWorkspaceApp,
  type SessionWorkspaceMode,
  type SessionWorkspaceState,
  type WorkspaceAppId,
} from '@/lib/workspace'

export function setSessionWorkspaceModeState(
  state: Record<string, SessionWorkspaceState>,
  sessionId: string,
  mode: SessionWorkspaceMode,
) {
  return {
    ...state,
    [sessionId]: {
      ...(state[sessionId] ?? getInitialWorkspaceSessionState()),
      mode,
    },
  }
}

export function setSessionWorkspaceAppState(
  state: Record<string, SessionWorkspaceState>,
  sessionId: string,
  app: WorkspaceAppId,
) {
  return {
    ...state,
    [sessionId]: {
      ...(state[sessionId] ?? getInitialWorkspaceSessionState()),
      activeApp: app === 'terminal' ? (state[sessionId]?.activeApp ?? 'overview') : app,
      ...(app === 'terminal' ? { mode: 'terminal' as const } : {}),
    },
  }
}

export function removeSessionWorkspaceState(
  state: Record<string, SessionWorkspaceState>,
  sessionId: string,
) {
  const next = { ...state }
  delete next[sessionId]
  return next
}

export function syncSessionTabWorkspace(
  tabs: SessionTab[],
  workspaceBySession: Record<string, SessionWorkspaceState>,
) {
  return tabs.map((tab) => {
    const workspace = workspaceBySession[tab.sessionId]
    if (!workspace) return tab
    return {
      ...tab,
      mode: workspace.mode,
      workspaceApp: normalizeWorkspaceApp(workspace.activeApp),
    }
  })
}
