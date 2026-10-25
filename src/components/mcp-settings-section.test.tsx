import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_MCP_PERMISSIONS } from '@/lib/mcp'
import { webcrypto } from 'node:crypto'
import { McpSettingsSection } from './mcp-settings-section'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { mcpAccessCopy } from '@/lib/locales/mcp-access'
const c = mcpAccessCopy.en
const vault = vi.hoisted(() => ({ activeVaultId: 'vault-a' }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => vault }))

const client = { id: 'client-a', name: 'Agent A', vaultId: 'vault-a', hosts: [{ id: 'h1', identity: 'hash' }],
  permissions: { refresh: false, execute: false, readFiles: false, writeFiles: false, recordDeployments: false, manageAlerts: false }, createdAt: 1 }
const host = { id: 'h1', name: 'Dev Server', address: '192.0.2.10', username: 'deploy', port: 22 }

describe('MCP settings', () => {
  beforeEach(() => {
    vault.activeVaultId = 'vault-a'
    vi.stubGlobal('crypto', webcrypto)
    localStorage.setItem('shellbeam.locale', 'en')
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mcp_status') return { enabled: false, running: false, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'list_hosts') return [host]
      if (command === 'mcp_create_client') return { client, configuration: { mcpServers: { shellbeam: { command: '/Applications/ShellBeam.app/app', args: ['--mcp-stdio', '/tmp/endpoint.json', client.id], env: { SHELLBEAM_MCP_TOKEN: 'one-time-token' } } } } }
      return undefined
    })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('grants an exact snippet revision and selected connection without arbitrary command permission', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'mcp_status') return { enabled: false, running: false, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'list_hosts') return [{ ...host, defaultConnectionId: 'ops', connections: [
        { id: 'ops', label: 'Operations account', address: host.address, port: 22, username: 'ops' },
        { id: 'admin', label: 'Administrator account', address: host.address, port: 2222, username: 'admin' },
      ] }]
      if (command === 'list_snippets') return [{ id: 'snippet-a', name: 'Inspect uptime', command: 'uptime', tags: [], createdAt: 1, updatedAt: 1 }]
      if (command === 'mcp_create_client') return { client, configuration: { mcpServers: { shellbeam: { command: '/app', args: [], env: { SHELLBEAM_MCP_TOKEN: 'test' } } } } }
    })
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    expect(invoke).not.toHaveBeenCalledWith('list_snippets', expect.anything())
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Snippet agent' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    expect(screen.getByLabelText(/Operations account/)).toBeChecked()
    expect(screen.getByLabelText(/Administrator account/)).not.toBeChecked()
    fireEvent.click(screen.getByLabelText(/Operations account/))
    fireEvent.click(screen.getByLabelText(/Administrator account/))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
    fireEvent.click(screen.getByLabelText(c.permission.runSnippets[0]))
    expect(screen.getByRole('button', { name: c.review })).toBeDisabled()
    fireEvent.click(await screen.findByLabelText('Inspect uptime'))
    expect(screen.getByText('uptime')).toBeVisible()
    authorize()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: {
      name: 'Snippet agent', vaultId: 'vault-a', hostIds: ['h1'], connectionIds: { h1: ['admin'] },
      permissions: { ...DEFAULT_MCP_PERMISSIONS, runSnippets: true },
      snippets: [{ id: 'snippet-a', revision: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    } }))
    expect(screen.queryByLabelText(c.permission.execute[0])).not.toBeInTheDocument()
    expect(screen.queryByLabelText(c.permission.readSnippets[0])).not.toBeInTheDocument()
  })

  it('discards a pending snippet load when sharing is disabled', async () => {
    let finish!: (rows: unknown) => void
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) => command === 'list_snippets' ? new Promise(resolve => { finish = resolve }) : original(command, args))
    render(<McpSettingsSection />)
    await preparePermissions()
    fireEvent.click(screen.getByLabelText(c.permission.readSnippets[0]))
    await waitFor(() => expect(finish).toBeDefined())
    fireEvent.click(screen.getByLabelText(c.permission.readSnippets[0]))
    finish([{ id: 'late', name: 'Late snippet', command: 'uptime', tags: [] }])
    await waitFor(() => expect(screen.queryByText(en['mcp.snippets'])).not.toBeInTheDocument())
    expect(screen.queryByLabelText('Late snippet')).not.toBeInTheDocument()
  })

  it('starts disabled without granting any remote permissions or selecting servers', async () => {
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    expect(screen.getByRole('button', { name: c.next })).toBeDisabled()
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(invoke).not.toHaveBeenCalledWith('mcp_create_client', expect.anything())
    expect(invoke).toHaveBeenCalledWith('list_hosts', { vaultId: 'vault-a' })
  })

  it('authorizes only explicitly selected hosts and capabilities and shows configuration once', async () => {
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Agent A' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
    fireEvent.click(screen.getByLabelText(c.permission.execute[0]))
    authorize()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: {
      name: 'Agent A', vaultId: 'vault-a', hostIds: ['h1'],
      permissions: { ...DEFAULT_MCP_PERMISSIONS, execute: true },
      connectionIds: { h1: ['h1'] }, snippets: [],
    } }))
    expect((await screen.findByLabelText('MCP client configuration') as HTMLTextAreaElement).value).toContain('one-time-token')
    fireEvent.click(screen.getByRole('button', { name: c.done }))
    expect(screen.queryByLabelText('MCP client configuration')).not.toBeInTheDocument()
  })

  it('keeps filtered bulk selection as a draft until final authorization and leaves existing clients unchanged', async () => {
    const baseInvoke = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'mcp_status') return { enabled: true, running: true, desktopSupported: true, clients: [client], activeOperations: 0, audit: [] }
      if (command === 'list_hosts') return [host, { ...host, id: 'h2', name: 'Production', group: 'Production' }]
      return baseInvoke(command, args)
    })
    render(<McpSettingsSection />)
    await screen.findByRole('checkbox', { name: 'Dev Server' })
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Bulk draft' } })
    fireEvent.click(screen.getByRole('checkbox', { name: c.selectAll }))
    fireEvent.change(screen.getByLabelText(c.search), { target: { value: 'Dev Server' } })
    fireEvent.click(screen.getByRole('checkbox', { name: c.selectAll }))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
    fireEvent.click(screen.getByRole('button', { name: c.review }))
    expect(invoke).not.toHaveBeenCalledWith('mcp_create_client', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('mcp_revoke_client', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('mcp_set_enabled', expect.anything())
    expect(screen.getByText('Agent A')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: en['mcp.create'] }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: {
      name: 'Bulk draft', vaultId: 'vault-a', hostIds: ['h2'],
      permissions: DEFAULT_MCP_PERMISSIONS, connectionIds: { h2: ['h2'] }, snippets: [],
    } }))
  })

  it('keeps Komari and local alert metadata acknowledgement and closure behind an explicit capability', async () => {
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Alert Agent' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
    const alertPermission = screen.getByLabelText(c.permission.manageAlerts[0])
    expect(alertPermission).not.toBeChecked()
    fireEvent.click(alertPermission)
    authorize()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: {
      name: 'Alert Agent', vaultId: 'vault-a', hostIds: ['h1'],
      permissions: { ...DEFAULT_MCP_PERMISSIONS, manageAlerts: true },
      connectionIds: { h1: ['h1'] }, snippets: [],
    } }))
  })

  it.each(['en', 'zh-CN'] as const)('keeps local alert semantics and technical guidance available in %s', async locale => {
    localStorage.setItem('shellbeam.locale', locale)
    render(<McpSettingsSection />)
    await screen.findByText('Dev Server')
    const copy = locale === 'en' ? en : zhCN; const ui = mcpAccessCopy[locale]
    fireEvent.change(screen.getByLabelText(copy['mcp.clientName']), { target: { value: 'Agent' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.click(screen.getByRole('button', { name: ui.next }))
    const permission = screen.getByLabelText(ui.permission.manageAlerts[0])
    expect(permission).not.toBeChecked()
    expect(permission.closest('label')).toHaveTextContent(ui.permission.manageAlerts[1])
    fireEvent.click(screen.getByRole('button', { name: ui.review }))
    fireEvent.click(screen.getByRole('button', { name: copy['mcp.create'] }))
    await screen.findByLabelText(copy['mcp.configuration'])
    const guidance = screen.getByText(copy['mcp.setupVerify'])
    expect(guidance.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText(ui.protocolHelp))
    for (const field of ['get_server_alerts.localOps.revision', "alertSource='local-ops'", 'ruleId', 'expectedRevision', 'acknowledge_server_alert', 'close_server_alert', 'get_server_operations']) expect(guidance).toHaveTextContent(field)
    expect(invoke).not.toHaveBeenCalledWith('mcp_set_enabled', expect.anything())
  })

  it('requires a second click before revocation', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mcp_status'
      ? { enabled: true, running: true, desktopSupported: true, clients: [client], activeOperations: 1, audit: [] }
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

  async function preparePermissions() {
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Agent A' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
  }

  function authorize() {
    fireEvent.click(screen.getByRole('button', { name: c.review }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and generate configuration' }))
  }

  async function generate() {
    await screen.findByText('Dev Server')
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Agent A' } })
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.click(screen.getByRole('button', { name: c.next }))
    authorize()
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
      if (command === 'mcp_status') return { enabled: true, running: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
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
      if (command === 'mcp_status') return { enabled: true, running: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
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
      if (command === 'mcp_status') return { enabled: true, running: true, desktopSupported: true, clients: [], activeOperations: 0, audit: [] }
      if (command === 'mcp_test_connection') return new Promise((done) => { resolve = done })
      return original(command, args, options)
    })
    render(<McpSettingsSection />)
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Check local bridge' }))
    fireEvent.click(screen.getByRole('button', { name: c.done }))
    await act(async () => { resolve({ toolCount: 3 }) })
    expect(screen.queryByLabelText('MCP client configuration')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('reviews the exact scope before creating and resets permissions after discarding the configuration', async () => {
    render(<McpSettingsSection />)
    await preparePermissions()
    fireEvent.click(screen.getByLabelText(c.permission.execute[0]))
    fireEvent.click(screen.getByRole('button', { name: c.review }))
    expect(invoke).not.toHaveBeenCalledWith('mcp_create_client', expect.anything())
    expect(screen.getByText(c.commandWarning)).toBeVisible()
    expect(screen.getByText('SSH · deploy@192.0.2.10:22')).toBeVisible()
    expect(screen.getByText(c.dataWarning)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and generate configuration' }))
    await screen.findByLabelText('MCP client configuration')
    expect(screen.queryByLabelText('Client name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: c.done }))
    expect(screen.getByLabelText('Client name')).toHaveValue('')
    expect(screen.getByLabelText('Dev Server')).not.toBeChecked()
    await preparePermissions()
    expect(screen.getByLabelText(c.permission.execute[0])).not.toBeChecked()
  })

  it('allows cached access for monitoring-only hosts but prevents an unusable remote grant', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args, options) => command === 'list_hosts' ? Promise.resolve([{ ...host, connections: [], address: '', port: 0, username: '' }]) : original(command, args, options))
    render(<McpSettingsSection />)
    await preparePermissions()
    fireEvent.click(screen.getByLabelText(c.permission.inspect[0]))
    expect(screen.getByRole('button', { name: c.review })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(c.sshNeeded)
    fireEvent.click(screen.getByLabelText(c.permission.inspect[0]))
    authorize()
    await screen.findByLabelText('MCP client configuration')
    expect(invoke).toHaveBeenCalledWith('mcp_create_client', { payload: { name: 'Agent A', vaultId: 'vault-a', hostIds: ['h1'], connectionIds: { h1: [] }, permissions: DEFAULT_MCP_PERMISSIONS, snippets: [] } })
  })

  it('clears authorization drafts and ignores a late configuration across vault switches', async () => {
    let finish!: (value: unknown) => void
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args, options) => command === 'mcp_create_client' ? new Promise(resolve => { finish = resolve }) : original(command, args, options))
    const { rerender } = render(<McpSettingsSection />)
    await preparePermissions()
    fireEvent.click(screen.getByLabelText(c.permission.execute[0]))
    authorize()
    await waitFor(() => expect(finish).toBeDefined())
    vault.activeVaultId = 'vault-b'
    rerender(<McpSettingsSection />)
    await screen.findByLabelText('Dev Server')
    await act(async () => { finish({ client, configuration: { mcpServers: { shellbeam: { command: '/app', args: [], env: { SHELLBEAM_MCP_TOKEN: 'stale-token' } } } } }) })
    expect(screen.queryByLabelText('MCP client configuration')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Client name')).toHaveValue('')
    expect(screen.getByLabelText('Dev Server')).not.toBeChecked()
    await preparePermissions()
    expect(screen.getByLabelText(c.permission.execute[0])).not.toBeChecked()
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'mcp_create_client')).toHaveLength(1)
  })

  it('does not duplicate a grant while the explicit authorization is pending', async () => {
    let finish!: (value: unknown) => void
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args, options) => command === 'mcp_create_client' ? new Promise(resolve => { finish = resolve }) : original(command, args, options))
    render(<McpSettingsSection />)
    await preparePermissions()
    authorize()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and generate configuration' }))
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'mcp_create_client')).toHaveLength(1)
    expect(screen.getByRole('button', { name: c.back })).toBeDisabled()
    await act(async () => { finish({ client, configuration: { mcpServers: { shellbeam: { command: '/app', args: [], env: { SHELLBEAM_MCP_TOKEN: 'one-time-token' } } } } }) })
    await screen.findByLabelText('MCP client configuration')
  })

  it('explains a multibyte name exceeding the native byte limit before submission', async () => {
    render(<McpSettingsSection />)
    await screen.findByLabelText('Dev Server')
    fireEvent.click(screen.getByLabelText('Dev Server'))
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: '名'.repeat(34) } })
    expect(screen.getByRole('alert')).toHaveTextContent(c.nameTooLong)
    expect(screen.getByRole('button', { name: c.next })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: '名'.repeat(33) } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: c.next })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalledWith('mcp_create_client', expect.anything())
  })

})
