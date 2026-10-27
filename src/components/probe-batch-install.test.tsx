import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'

const handleUpdateHost = vi.fn(async () => {})
const prepare = vi.fn()
const operate = vi.fn()
const decide = vi.fn(async () => ({ accepted: true, reason: 'accepted' }))
const sources = vi.fn()

vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ handleUpdateHost }) }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'v1', captureVaultScope: () => () => true }) }))
vi.mock('@/lib/komari-source-eligibility', () => ({ loadCurrentKomariSources: (...args: unknown[]) => sources(...args) }))
vi.mock('@/lib/compatible-agent', () => ({
  readCompatibleAgent: vi.fn(async () => null),
  prepareCompatibleAgent: (...args: unknown[]) => prepare(...args),
  operateCompatibleAgent: (...args: unknown[]) => operate(...args),
  cancelCompatibleAgent: vi.fn(async () => {}),
}))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: (...args: unknown[]) => decide(...(args as [])) }))

import { ProbeBatchInstallDialog } from './probe-batch-install'

const host = (id: string, patch: Partial<HostProfile> = {}) => ({ id, vaultId: 'v1', name: id, address: `10.0.0.${id.length}`, port: 22, username: 'root', group: 'production', authType: 'privateKey', tags: [], createdAt: 1, updatedAt: 1, monitoringMode: 'server', ...patch }) as HostProfile
const source = {
  integration: { id: 's1', vaultId: 'v1', name: 's1', endpoint: 'https://monitor.example', credentialRef: '', enabled: true, createdAt: 1, updatedAt: 1 },
  state: { mappings: ['ready', 'mode', 'broken'].map((hostId) => ({ hostId, nodeId: `node-${hostId}`, integrationId: 's1', source: 'manual' })) },
  mappingRevision: 1, error: false,
}
const rowState = (id: string) => screen.getAllByTestId('probe-batch-row').find((row) => row.dataset.hostId === id)?.dataset.state

describe('ProbeBatchInstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sources.mockResolvedValue([source])
    prepare.mockImplementation(async ({ hostId }: { hostId: string }) => {
      if (hostId === 'broken') throw new Error('KOMARI_AGENT_LINUX_REQUIRED')
      return { planId: `plan-${hostId}`, targetVersion: '1.5.13' }
    })
    operate.mockResolvedValue({ status: 'active', errorCode: null })
  })

  const hosts = [host('ready'), host('mode', { monitoringMode: 'ssh' }), host('broken'), host('nonode')]

  it('preflights every host and only offers hosts that can install', async () => {
    render(<ProbeBatchInstallDialog hosts={hosts} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-batch-dialog')).toHaveAttribute('data-phase', 'review'))
    expect(rowState('ready')).toBe('ready')
    expect(rowState('mode')).toBe('switch')
    expect(rowState('broken')).toBe('blocked')
    expect(rowState('nonode')).toBe('blocked')
    // ssh-mode hosts are not prepared until their mode is switched.
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('probe-batch-confirm')).toHaveTextContent('2')
  })

  it('installs after one confirmation, switching the mode first where needed', async () => {
    render(<ProbeBatchInstallDialog hosts={hosts} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-batch-confirm')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('probe-batch-confirm'))
    await waitFor(() => expect(screen.getByTestId('probe-batch-dialog')).toHaveAttribute('data-phase', 'finished'))
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }))
    expect(handleUpdateHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'mode' }), expect.objectContaining({ monitoringMode: 'server' }))
    expect(operate).toHaveBeenCalledWith('plan-ready', true)
    expect(operate).toHaveBeenCalledWith('plan-mode', true)
    expect(operate).toHaveBeenCalledTimes(2)
    expect(rowState('ready')).toBe('done')
    expect(rowState('mode')).toBe('done')
    expect(rowState('broken')).toBe('skipped')
  })

  it('installs nothing when the confirmation is declined', async () => {
    decide.mockResolvedValueOnce({ accepted: false, reason: 'rejected' })
    render(<ProbeBatchInstallDialog hosts={hosts} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-batch-confirm')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('probe-batch-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    expect(operate).not.toHaveBeenCalled()
    expect(handleUpdateHost).not.toHaveBeenCalled()
  })

  it('reports a per-host failure without stopping the others', async () => {
    operate.mockImplementation(async (planId: string) => {
      if (planId === 'plan-ready') throw new Error('KOMARI_AGENT_REPORT_TIMEOUT')
      return { status: 'active', errorCode: null }
    })
    render(<ProbeBatchInstallDialog hosts={hosts} open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('probe-batch-confirm')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('probe-batch-confirm'))
    await waitFor(() => expect(screen.getByTestId('probe-batch-dialog')).toHaveAttribute('data-phase', 'finished'))
    expect(rowState('ready')).toBe('failed')
    expect(rowState('mode')).toBe('done')
  })
})
