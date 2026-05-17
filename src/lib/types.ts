import type { SessionWorkspaceMode, WorkspaceAppId } from '@/lib/workspace'

export type PaneId = 'left' | 'right'

export interface PaneEvent {
  id: string
  pane: PaneId
  sessionId: string | null
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface ReconnectSettings {
  enabled: boolean
  maxRetries: number
  intervalMs: number
}

export interface SecurityEvent {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface SessionTab {
  sessionId: string
  hostName: string
  hostAddress: string
  hostId?: string
  connectionKind?: 'host' | 'local'
  connectionStage?: string
  status: 'connecting' | 'connected' | 'closed' | 'error' | 'reconnecting'
  errorMessage?: string
  mode?: SessionWorkspaceMode
  workspaceApp?: WorkspaceAppId
}
