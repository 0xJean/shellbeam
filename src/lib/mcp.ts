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

export type McpClientTarget = 'codex' | 'claude' | 'generic'
export interface McpConfiguration {
  mcpServers: { shellbeam: { command: string; args: string[]; env: { SHELLBEAM_MCP_TOKEN: string } } }
}

export function formatMcpConfiguration(configuration: McpConfiguration, target: McpClientTarget): string {
  if (target !== 'codex') return JSON.stringify(configuration, null, 2)
  const server = configuration.mcpServers.shellbeam
  // JSON basic string escaping is also valid for the TOML strings used here.
  return [
    '[mcp_servers.shellbeam]',
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    '', '[mcp_servers.shellbeam.env]',
    `SHELLBEAM_MCP_TOKEN = ${JSON.stringify(server.env.SHELLBEAM_MCP_TOKEN)}`,
  ].join('\n')
}

export function testMcpConnection(clientId: string, token: string) {
  return invoke<{ toolCount: number }>('mcp_test_connection', { clientId, token })
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
  return invoke<{ client: McpClient; configuration: McpConfiguration }>('mcp_create_client', { payload })
}

export function revokeMcpClient(clientId: string) {
  return invoke<void>('mcp_revoke_client', { clientId })
}
