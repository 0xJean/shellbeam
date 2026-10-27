import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { ProbeInstallReadiness } from '@/lib/probe-install'

const state = vi.hoisted(() => ({ readiness: null as ProbeInstallReadiness | null }))
const setPcSidebarNav = vi.fn()
const handleUpdateHost = vi.fn(async () => {})
const reload = vi.fn()
const prepare = vi.fn()
const operate = vi.fn()
const decide = vi.fn(async () => ({ accepted: true, reason: 'accepted' }))
const requestCategory = vi.fn()
const createNode = vi.fn()
const enableLinger = vi.fn()

vi.mock('@/contexts/app-context', () => ({ useApp: () => ({ setPcSidebarNav }) }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: [], handleUpdateHost }) }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'v1', vaultStatusState: { unlocked: true }, handleRevealSecret: vi.fn(), captureVaultScope: () => () => true }) }))
vi.mock('@/hooks/use-probe-install-readiness', () => ({ PROBE_DEPLOYMENT_CHANGED_EVENT: 'shellbeam:probe-deployment-changed', useProbeInstallReadiness: () => ({ readiness: state.readiness, record: null, reload }) }))
vi.mock('@/components/komari-mappings-panel', () => ({ KomariMappingsPanel: () => <div data-testid="mapping-panel" /> }))
vi.mock('@/lib/compatible-agent', () => ({ prepareCompatibleAgent: (...args: unknown[]) => prepare(...args), operateCompatibleAgent: (...args: unknown[]) => operate(...args), enableProbeLinger: (...args: unknown[]) => enableLinger(...args), cancelCompatibleAgent: vi.fn(async () => {}) }))
vi.mock('@/lib/komari-persistence', () => ({ createKomariNodeForHost: (...args: unknown[]) => createNode(...args) }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn(async () => [{ id: 's1', name: 'Home Server', endpoint: 'https://monitor.example' }]) }))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: (...args: unknown[]) => decide(...(args as [])) }))
vi.mock('@/lib/settings-request', () => ({ requestSettingsCategory: (...args: unknown[]) => requestCategory(...args) }))

import { ProbeInstallDialog } from './probe-install-dialog'

const host = { id: 'h1', vaultId: 'v1', name: 'redis-cache', address: '10.0.3.20', port: 22, username: 'deploy', group: 'production', authType: 'privateKey', tags: [], createdAt: 1, updatedAt: 1, monitoringMode: 'server' } as HostProfile
const preview = { planId: 'p1', action: 'install', hostName: 'redis-cache', nodeId: 'node-1', endpoint: 'https://monitor.example', transport: 'direct', account: 'root', serviceScope: 'system', dataDirectory: '/opt/shellbeam-probe', artifactBytes: 1048576, currentVersion: null, targetVersion: '1.5.13', status: 'absent', expiresAt: Date.now() + 60_000 }

describe('ProbeInstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.readiness = null
  })

  it('starts at the server step and opens monitoring settings', () => {
    state.readiness = { stage: 'no-server' }
    const onOpenChange = vi.fn()
    render(<ProbeInstallDialog host={host} open onOpenChange={onOpenChange} />)
    expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '1')
    fireEvent.click(screen.getByRole('button', { name: /Monitoring|监控与通知/ }))
    expect(requestCategory).toHaveBeenCalledWith('monitoring')
    expect(setPcSidebarNav).toHaveBeenCalledWith('settings')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('creates and links a node automatically, keeping manual mapping available', async () => {
    state.readiness = { stage: 'no-node', integrationId: 's1' }
    createNode.mockResolvedValue({ mappings: [], revision: 2 })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '2')
    expect(screen.getByTestId('mapping-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('probe-create-node'))
    await waitFor(() => expect(createNode).toHaveBeenCalledWith({ vaultId: 'v1', integrationId: 's1', hostId: 'h1' }))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Home Server') }))
    expect(reload).toHaveBeenCalled()
  })

  it('does not create a node when the confirmation is declined', async () => {
    state.readiness = { stage: 'no-node', integrationId: 's1' }
    decide.mockResolvedValueOnce({ accepted: false, reason: 'rejected' })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-create-node'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    expect(createNode).not.toHaveBeenCalled()
  })

  it('enables linger after a high-risk confirmation and re-runs the check', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockRejectedValueOnce(new Error('KOMARI_AGENT_LINGER_REQUIRED')).mockResolvedValueOnce(preview)
    enableLinger.mockResolvedValue(undefined)
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-install-check'))
    await waitFor(() => expect(screen.getByTestId('probe-fix-linger')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('probe-fix-linger'))
    await waitFor(() => expect(enableLinger).toHaveBeenCalledWith({ vaultId: 'v1', hostId: 'h1' }))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }))
    await waitFor(() => expect(screen.getByTestId('probe-install-confirm')).toBeInTheDocument())
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('explains when linger needs a password', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockRejectedValue(new Error('KOMARI_AGENT_LINGER_REQUIRED'))
    enableLinger.mockRejectedValue(new Error('KOMARI_AGENT_LINGER_SUDO_REQUIRED'))
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-install-check'))
    await waitFor(() => expect(screen.getByTestId('probe-fix-linger')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('probe-fix-linger'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/password|密码/))
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('switches the monitoring mode only after confirmation', async () => {
    state.readiness = { stage: 'ssh-mode', integrationId: 's1' }
    render(<ProbeInstallDialog host={{ ...host, monitoringMode: 'ssh' }} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /monitoring mode|切换监控方式/ }))
    await waitFor(() => expect(handleUpdateHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }), expect.objectContaining({ monitoringMode: 'server' })))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ risk: 'low' }))
    expect(reload).toHaveBeenCalled()
  })

  it('runs the read-only check, then installs after a high-risk confirmation', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockResolvedValue(preview)
    operate.mockResolvedValue({ status: 'active', jobId: 'job-1', current: { manifest: { version: '1.5.13' } }, errorCode: null })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-install-check'))
    await waitFor(() => expect(screen.getByTestId('probe-install-confirm')).toBeInTheDocument())
    expect(prepare).toHaveBeenCalledWith({ vaultId: 'v1', hostId: 'h1', integrationId: 's1', action: 'install' })
    expect(screen.getByTestId('probe-check-ssh')).toHaveAttribute('data-state', 'ok')
    fireEvent.click(screen.getByTestId('probe-install-confirm'))
    await waitFor(() => expect(operate).toHaveBeenCalledWith('p1', true))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }))
    await waitFor(() => expect(screen.getByTestId('probe-install-dialog')).toHaveAttribute('data-step', '4'))
  })

  it('does not install when the confirmation is declined', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockResolvedValue(preview)
    decide.mockResolvedValueOnce({ accepted: false, reason: 'rejected' })
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-install-check'))
    await waitFor(() => expect(screen.getByTestId('probe-install-confirm')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('probe-install-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    expect(operate).not.toHaveBeenCalled()
  })

  it('maps a failed check onto its row with the fix hint', async () => {
    state.readiness = { stage: 'ready', integrationId: 's1', nodeId: 'n1' }
    prepare.mockRejectedValue(new Error('KOMARI_AGENT_LINGER_REQUIRED'))
    render(<ProbeInstallDialog host={host} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('probe-install-check'))
    await waitFor(() => expect(screen.getByTestId('probe-check-account')).toHaveAttribute('data-state', 'bad'))
    expect(screen.getByTestId('probe-check-account')).toHaveTextContent('loginctl enable-linger deploy')
    expect(screen.getByTestId('probe-check-ssh')).toHaveAttribute('data-state', 'ok')
    expect(screen.queryByTestId('probe-install-confirm')).not.toBeInTheDocument()
  })
})
