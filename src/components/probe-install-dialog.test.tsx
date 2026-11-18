import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { ProbeInstallReadiness } from '@/lib/probe-install'

const state = vi.hoisted(() => ({ readiness: null as ProbeInstallReadiness | null }))
const setPcSidebarNav = vi.fn()
const handleUpdateHost = vi.fn(async () => {})
const handleSaveSecret = vi.fn(async () => {})
const handleRevealSecret = vi.fn(async () => null)
const reload = vi.fn()
const prepare = vi.fn()
const operate = vi.fn()
const decide = vi.fn(async () => ({ accepted: true, reason: 'accepted' }))
const requestCategory = vi.fn()
const createNode = vi.fn()
const enableLinger = vi.fn()

vi.mock('@/contexts/app-context', () => ({ useApp: () => ({ setPcSidebarNav }) }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: [], handleUpdateHost }) }))
vi.mock('@/contexts/vault-context', () => ({
  useVault: () => ({
    activeVaultId: 'v1',
    vaultStatusState: { unlocked: true },
    handleSaveSecret,
    handleRevealSecret,
    captureVaultScope: () => () => true,
  }),
}))
vi.mock('@/hooks/use-probe-install-readiness', () => ({
  PROBE_DEPLOYMENT_CHANGED_EVENT: 'shellbeam:probe-deployment-changed',
  invalidateProbeInstallSources: vi.fn(),
  useProbeInstallReadiness: () => ({ readiness: state.readiness, record: null, reload }),
}))
vi.mock('@/components/komari-mappings-panel', () => ({ KomariMappingsPanel: () => <div data-testid="mapping-panel" /> }))
vi.mock('@/lib/compatible-agent', () => ({
  prepareCompatibleAgent: (...args: unknown[]) => prepare(...args),
  operateCompatibleAgent: (...args: unknown[]) => operate(...args),
  enableProbeLinger: (...args: unknown[]) => enableLinger(...args),
  cancelCompatibleAgent: vi.fn(async () => {}),
}))
vi.mock('@/lib/komari-persistence', async (original) => ({
  ...await original<typeof import('@/lib/komari-persistence')>(),
  createKomariNodeForHost: (...args: unknown[]) => createNode(...args),
}))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: (...args: unknown[]) => decide(...(args as [])) }))
vi.mock('@/lib/settings-request', () => ({ requestSettingsCategory: (...args: unknown[]) => requestCategory(...args) }))

import { ProbeInstallDialog } from './probe-install-dialog'

const host = {
  id: 'h1',
  vaultId: 'v1',
  name: 'redis-cache',
  address: '10.0.3.20',
  port: 22,
  username: 'deploy',
  group: 'production',
  authType: 'privateKey',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  monitoringMode: 'server',
} as HostProfile

const preview = {
  planId: 'p1',
  action: 'install',
  hostName: 'redis-cache',
  nodeId: 'node-1',
  endpoint: 'https://monitor.example',
  transport: 'direct',
  account: 'root',
  serviceScope: 'system',
  dataDirectory: '/opt/shellbeam-probe',
  artifactBytes: 1048576,
  currentVersion: null,
  targetVersion: '1.5.13',
  status: 'absent',
  expiresAt: Date.now() + 60_000,
}

describe('ProbeInstallDialog (automated one-flow installer)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.readiness = null
  })
  afterEach(() => cleanup())

  it('embeds InlineServerConnect at step 1 when no server is configured while keeping settings shortcut', () => {
    state.readiness = { stage: 'no-server' }
    const onOpenChange = vi.fn()
    render(<ProbeInstallDialog host={host} open onOpenChange={onOpenChange} />)
    expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '1')
    expect(screen.getByTestId('inline-server-connect')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Monitoring|监控与通知/ }))
    expect(requestCategory).toHaveBeenCalledWith('monitoring')
    expect(setPcSidebarNav).toHaveBeenCalledWith('settings')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('automatically switches host to server mode without confirmation popups', async () => {
    state.readiness = { stage: 'ssh-mode', integrationId: 's1' }
    render(<ProbeInstallDialog host={{ ...host, monitoringMode: 'ssh' }} open onOpenChange={vi.fn()} />)
    await waitFor(() =>
      expect(handleUpdateHost).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'h1' }),
        expect.objectContaining({ monitoringMode: 'server' }),
      ),
    )
    expect(decide).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })

  it('automatically creates and links a node on ShellBeam Server without manual prompts', async () => {
    state.readiness = { stage: 'no-node', integrationId: 's1' }
    createNode.mockResolvedValue({ mappings: [], revision: 2 })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(createNode).toHaveBeenCalledWith({ vaultId: 'v1', integrationId: 's1', hostId: 'h1' }))
    expect(decide).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })

  it('automatically runs preflight and installs the probe when ready', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockResolvedValue(preview)
    operate.mockResolvedValue({
      status: 'active',
      jobId: 'job-1',
      current: { manifest: { version: '1.5.13' } },
      errorCode: null,
    })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)

    await waitFor(() => expect(prepare).toHaveBeenCalledWith({ vaultId: 'v1', hostId: 'h1', integrationId: 's1', action: 'install' }))
    await waitFor(() => expect(operate).toHaveBeenCalledWith('p1', true))
    expect(decide).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '4'))
  })

  it('pauses on privilege requirement (linger), asks confirmation for linger, then resumes check and install', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockRejectedValueOnce(new Error('KOMARI_AGENT_LINGER_REQUIRED')).mockResolvedValueOnce(preview)
    enableLinger.mockResolvedValue(undefined)
    operate.mockResolvedValue({
      status: 'active',
      jobId: 'job-2',
      current: { manifest: { version: '1.5.13' } },
      errorCode: null,
    })

    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-check-account')).toHaveAttribute('data-state', 'bad'))
    expect(screen.getByTestId('probe-check-account')).toHaveTextContent('loginctl enable-linger deploy')

    fireEvent.click(screen.getByTestId('probe-fix-linger'))
    await waitFor(() => expect(enableLinger).toHaveBeenCalledWith({ vaultId: 'v1', hostId: 'h1' }))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }))
    await waitFor(() => expect(operate).toHaveBeenCalledWith('p1', true))
    await waitFor(() => expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '4'))
  })

  it('explains when linger needs a sudo password', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockRejectedValue(new Error('KOMARI_AGENT_LINGER_REQUIRED'))
    enableLinger.mockRejectedValue(new Error('KOMARI_AGENT_LINGER_SUDO_REQUIRED'))

    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-fix-linger')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('probe-fix-linger'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/password|密码/))
    expect(operate).not.toHaveBeenCalled()
  })
})
