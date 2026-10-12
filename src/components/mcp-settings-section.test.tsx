import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { McpSettingsSection } from './mcp-settings-section'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault-a' }) }))

const client = { id: 'client-a', name: 'Agent A', vaultId: 'vault-a', hosts: [{ id: 'h1', identity: 'hash' }],
  permissions: { refresh: false, execute: false, readFiles: false, writeFiles: false }, createdAt: 1 }
const host = { id: 'h1', name: 'Dev Server', address: '192.0.2.10', username: 'deploy', port: 22 }

describe('MCP settings', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mcp_status') return { enabled: false, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'list_hosts') return [host]
      if (command === 'mcp_create_client') return { client, configuration: { mcpServers: { shellbeam: { command: '/Applications/ShellBeam.app/app', args: ['--mcp-stdio', '/tmp/endpoint.json', client.id], env: { SHELLBEAM_MCP_TOKEN: 'one-time-token' } } } } }
      return undefined
    })
  })
  afterEach(cleanup)

  it('starts disabled without granting any remote permissions or selecting servers', async () => {
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    expect(screen.getByRole('button', { name: 'Authorize and generate configuration' })).toBeDisabled()
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(invoke).not.toHaveBeenCalledWith('mcp_create_client', expect.anything())
    expect(invoke).toHaveBeenCalledWith('list_hosts', { vaultId: 'vault-a' })
  })

  it('authorizes only explicitly selected hosts and capabilities and shows configuration once', async () => {
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Agent A' } })
    fireEvent.click(screen.getByLabelText(/Dev Server/))
    fireEvent.click(screen.getByLabelText(/Execute arbitrary remote commands/))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and generate configuration' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: {
      name: 'Agent A', vaultId: 'vault-a', hostIds: ['h1'],
      permissions: { refresh: false, execute: true, readFiles: false, writeFiles: false },
    } }))
    expect((await screen.findByLabelText('MCP client configuration') as HTMLTextAreaElement).value).toContain('one-time-token')
    fireEvent.click(screen.getByRole('button', { name: 'Hide and discard configuration' }))
    expect(screen.queryByLabelText('MCP client configuration')).not.toBeInTheDocument()
  })

  it('requires a second click before revocation', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mcp_status'
      ? { enabled: true, desktopSupported: true, clients: [client], activeOperations: 1, audit: [] }
      : command === 'list_hosts' ? [host] : undefined)
    render(<McpSettingsSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(invoke).not.toHaveBeenCalledWith('mcp_revoke_client', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_revoke_client', { clientId: 'client-a' }))
  })

  it('surfaces backend errors instead of displaying a successful enable', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args, options) => command === 'mcp_set_enabled'
      ? Promise.reject(new Error('MCP failed to start')) : original(command, args, options))
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    fireEvent.click(screen.getByLabelText('Enable local MCP'))
    expect(await screen.findByRole('alert')).toHaveTextContent('MCP failed to start')
    expect(screen.getByLabelText('Enable local MCP')).not.toBeChecked()
  })

  it('has matching English and Chinese MCP messages', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('mcp.'))
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.sort()).toEqual(Object.keys(zhCN).filter((key) => key.startsWith('mcp.')).sort())
    for (const key of keys) expect(zhCN[key]).toBeTruthy()
  })

  async function generate() {
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Agent A' } })
    fireEvent.click(screen.getByLabelText(/Dev Server/))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and generate configuration' }))
    return await screen.findByLabelText('MCP client configuration') as HTMLTextAreaElement
  }

  it('switches between Codex TOML and Claude JSON without issuing a new authorization', async () => {
    render(<McpSettingsSection />)
    const configuration = await generate()
    expect(configuration.value).toContain('[mcp_servers.shellbeam]')
    fireEvent.click(screen.getByRole('button', { name: 'Claude Desktop' }))
    expect(JSON.parse(configuration.value).mcpServers.shellbeam.env.SHELLBEAM_MCP_TOKEN).toBe('one-time-token')
    expect(screen.getByText(/Settings > Developer > Edit Config/)).toBeInTheDocument()
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'mcp_create_client')).toHaveLength(1)
    expect(Object.values(localStorage).join('')).not.toContain('one-time-token')
  })

  it('does not test a bridge while MCP is disabled', async () => {
    render(<McpSettingsSection />)
    await generate()
    expect(screen.getByRole('button', { name: 'Check local bridge' })).toBeDisabled()
    expect(invoke).not.toHaveBeenCalledWith('mcp_test_connection', expect.anything())
  })

  it('checks only the generated authorization and describes the limited scope of success', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === 'mcp_status') return { enabled: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'mcp_test_connection') return { toolCount: 3 }
      return original(command, args, options)
    })
    render(<McpSettingsSection />)
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Check local bridge' }))
    expect(await screen.findByRole('status')).toHaveTextContent('3 authorized tools')
    expect(screen.getByRole('status')).toHaveTextContent('Complete the desktop client verification')
    expect(invoke).toHaveBeenCalledWith('mcp_test_connection', { clientId: 'client-a', token: 'one-time-token' })
    expect(invoke).not.toHaveBeenCalledWith('ssh_exec', expect.anything())
  })

  it('shows actionable connection failure without echoing token-bearing errors', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === 'mcp_status') return { enabled: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'mcp_test_connection') throw new Error('private token reflected')
      return original(command, args, options)
    })
    render(<McpSettingsSection />)
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Check local bridge' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Local bridge check failed')
    expect(screen.getByRole('status')).not.toHaveTextContent('private token')
  })

  it('discards pending check results when the one-time configuration is hidden', async () => {
    let resolve!: (result: { toolCount: number }) => void
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === 'mcp_status') return { enabled: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'mcp_test_connection') return new Promise((done) => { resolve = done })
      return original(command, args, options)
    })
    render(<McpSettingsSection />)
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Check local bridge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide and discard configuration' }))
    await act(async () => { resolve({ toolCount: 3 }) })
    expect(screen.queryByLabelText('MCP client configuration')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
