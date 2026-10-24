import { describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { formatMcpConfiguration, mcpSnippetRevision, type McpConfiguration } from './mcp'

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


it('uses the native UTF-8 content revision without normalizing commands', async () => {
  vi.stubGlobal('crypto', webcrypto)
  try {
    expect(await mcpSnippetRevision("printf '你好\\n'"))
      .toBe('c9d59c4aa5da6115e1e63425d8a34829b6a040fd55f60c7287f5e58b23d2d2f5')
    expect(await mcpSnippetRevision('uptime')).not.toBe(await mcpSnippetRevision('uptime\n'))
  } finally { vi.unstubAllGlobals() }
})
