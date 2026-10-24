import { invoke } from '@tauri-apps/api/core'

export interface McpPermissions {
  readSnippets?: boolean
  runSnippets?: boolean
  inspect?: boolean
  refresh: boolean
  execute: boolean
  readFiles: boolean
  writeFiles: boolean
  recordDeployments: boolean
  /** Acknowledge/close Komari or local service, health-check and ProbeProvider
   * alert metadata for this client's Vault and authorized hosts only. These
   * actions retain the OperationJob audit and never perform remote changes. */
  manageAlerts: boolean
}

export const DEFAULT_MCP_PERMISSIONS: McpPermissions = {
  readSnippets: false,
  runSnippets: false,
  inspect: false,
  refresh: false,
  execute: false,
  readFiles: false,
  writeFiles: false,
  recordDeployments: false,
  manageAlerts: false,
}

export interface McpClient {
  id: string
  name: string
  vaultId: string
  hosts: { id: string; identity: string; connections?: { id: string; identity: string }[] }[]
  snippets?: { id: string; revision: string }[]
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
  running: boolean
  desktopSupported: boolean
  clients: McpClient[]
  activeOperations: number
  audit: McpAuditEntry[]
}

export interface McpDeploymentRecord {
  deploymentId: string
  clientId: string
  agentName?: string
  vaultId: string
  hostId: string
  name: string
  deploymentPath: string
  projectKind: string
  status: string
  source: {
    repository?: string
    ref?: string
    commit?: string
    artifact?: string
  } | null
  dependencies: Array<{ name: string; version?: string; kind?: string; source?: string }> | null
  components: Array<{ name: string; type: string; version?: string; path?: string; status?: string }> | null
  runtime: {
    language?: string
    version?: string
    packageManager?: string
    processManager?: string
    entrypoint?: string
    serviceName?: string
    containerName?: string
    ports?: string
  } | null
  notes: string
  createdAt: number
  updatedAt: number
  lastVerifiedAt?: number | null
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

export function listMcpDeploymentRecords(vaultId: string, hostId?: string) {
  return invoke<{ projects: McpDeploymentRecord[]; total: number; observedAt: number }>(
    'mcp_list_project_deployments',
    { vaultId, hostId: hostId ?? null },
  )
}

export function setMcpEnabled(enabled: boolean) {
  return invoke<void>('mcp_set_enabled', { enabled })
}

export function createMcpClient(payload: {
  name: string
  vaultId: string
  hostIds: string[]
  permissions: McpPermissions
  connectionIds?: Record<string, string[]>
  snippets?: { id: string; revision: string }[]
}) {
  return invoke<{ client: McpClient; configuration: McpConfiguration }>('mcp_create_client', { payload })
}

/** Content revision matches the native SHA-256 check; usage timestamps are irrelevant. */
export async function mcpSnippetRevision(command: string): Promise<string> {
  const bytes = new TextEncoder().encode(command)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function revokeMcpClient(clientId: string) {
  return invoke<void>('mcp_revoke_client', { clientId })
}
