import { describe, expect, it } from 'vitest'
import { formatMcpConfiguration, type McpConfiguration } from './mcp'

const configuration: McpConfiguration = { mcpServers: { shellbeam: {
  command: 'C:\\Program Files\\ShellBeam\\ShellBeam.exe', args: ['--mcp-stdio', 'C:\\Users\\张\\path "quoted"\\mcp_endpoint.json', 'client-id'],
  env: { SHELLBEAM_MCP_TOKEN: 'example-token' },
} } }

describe('MCP client configuration', () => {
  it('formats Codex TOML with correctly escaped paths, arguments and token', () => {
    const value = formatMcpConfiguration(configuration, 'codex')
    expect(value).toContain('[mcp_servers.shellbeam]\n')
    expect(value).toContain('[mcp_servers.shellbeam.env]\n')
    expect(value).toContain(`command = ${JSON.stringify(configuration.mcpServers.shellbeam.command)}`)
    expect(value).toContain(`args = ${JSON.stringify(configuration.mcpServers.shellbeam.args)}`)
    expect(value).toContain('SHELLBEAM_MCP_TOKEN = "example-token"')
    expect(value).not.toContain('mcpServers')
  })

  it.each(['claude', 'generic'] as const)('keeps the stdio configuration intact for %s', (target) => {
    expect(JSON.parse(formatMcpConfiguration(configuration, target))).toEqual(configuration)
  })
})
