export const WORKSPACE_APPS = ['overview', 'assetInventory', 'fileTransfer', 'fileSystem', 'processes', 'services', 'toolManager', 'logs', 'browser', 'terminal', 'docker', 'sitesSsl', 'scheduledTasks'] as const

export type WorkspaceAppId = (typeof WORKSPACE_APPS)[number]

export type SessionWorkspaceMode = 'terminal' | 'workspace' | 'browser'

export interface SessionWorkspaceState {
  mode: SessionWorkspaceMode
  activeApp: WorkspaceAppId
}

export const DEFAULT_WORKSPACE_MODE: SessionWorkspaceMode = 'terminal'
export const DEFAULT_WORKSPACE_APP: WorkspaceAppId = 'overview'

export function getInitialWorkspaceSessionState(): SessionWorkspaceState {
  return {
    mode: DEFAULT_WORKSPACE_MODE,
    activeApp: DEFAULT_WORKSPACE_APP,
  }
}

export function isWorkspaceApp(value: string): value is WorkspaceAppId {
  return (WORKSPACE_APPS as readonly string[]).includes(value)
}

export function normalizeWorkspaceApp(value: string): WorkspaceAppId {
  if (value === 'files') return 'fileTransfer'
  return isWorkspaceApp(value) ? value : DEFAULT_WORKSPACE_APP
}
