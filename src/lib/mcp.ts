import { invoke } from '@tauri-apps/api/core'

export interface McpPermissions {
  refresh: boolean
  execute: boolean
  readFiles: boolean
  writeFiles: boolean
}

export const DEFAULT_MCP_PERMISSIONS: McpPermissions = {
  refresh: false,
  execute: false,
  readFiles: false,
  writeFiles: false,
}

export interface McpClient {
  id: string
  name: string
  vaultId: string
  hosts: { id: string; identity: string }[]
  permissions: McpPermissions
  createdAt: number
}

export interface McpAuditEntry {
  clientId: string
  hostId: string | null
  tool: string
  outcome: string
  at: number
}

export interface McpStatus {
  enabled: boolean
  desktopSupported: boolean
  clients: McpClient[]
  activeOperations: number
  audit: McpAuditEntry[]
}

export function getMcpStatus() {
  return invoke<McpStatus>('mcp_status')
}

export function setMcpEnabled(enabled: boolean) {
  return invoke<void>('mcp_set_enabled', { enabled })
}

export function createMcpClient(payload: {
  name: string
  vaultId: string
  hostIds: string[]
  permissions: McpPermissions
}) {
  return invoke<{ client: McpClient; configuration: Record<string, unknown> }>('mcp_create_client', { payload })
}

export function revokeMcpClient(clientId: string) {
  return invoke<void>('mcp_revoke_client', { clientId })
}
