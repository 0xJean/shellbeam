import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostNotificationRulesPanel, RuleEditor } from './host-notification-rules-panel'
import type { HostProfile } from '@/lib/hosts'
import type { KomariIntegration } from '@/lib/komari-config'
import { KomariApiError } from '@/lib/komari'
import * as rules from '@/lib/host-notification-rules'
import { metadataSession } from '@/lib/host-metadata-sync'
import { vaultGetSecret } from '@/lib/vault'
import { listKomariIntegrations } from '@/lib/komari-config'
vi.mock('@/lib/host-notification-rules', async original => ({ ...await original<typeof rules>(), listHostRules: vi.fn(), saveHostRule: vi.fn(), ruleAction: vi.fn(), readOfflineRule: vi.fn(), syncHostRules: vi.fn() }))
vi.mock('@/lib/host-metadata-sync', () => ({ metadataSession: vi.fn() }))
vi.mock('@/lib/vault', () => ({ vaultGetSecret: vi.fn() }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
const host: HostProfile = { id: 'h', vaultId: 'v', name: 'WEB', address: '', port: 0, username: '', authType: 'password', group: 'prod', tags: [], createdAt: 1, updatedAt: 2, connections: [] }
const target = { integration: { id: 'i', vaultId: 'v', name: 'Production', endpoint: 'https://monitor.test', credentialRef: 'ref', enabled: true, updatedAt: 7 } as KomariIntegration, nodeId: 'n', revision: 3 }
const observation: rules.RuleObservation = { identity: 'n:created', rule: { enabled: false, gracePeriod: 180 } }
function intent(status: rules.HostRuleIntent['status'] = 'pending'): rules.HostRuleIntent {
  return { id: 'r', vaultId: 'v', hostId: 'h', integrationId: 'i', nodeId: 'n', endpoint: target.integration.endpoint, credentialRef: 'ref', integrationVersion: 7, mappingRevision: 3, hostCreatedAt: 1, baseline: observation, remote: observation, desired: { enabled: true, gracePeriod: 120 }, status, version: 5, jobId: 'one-audited-job', errorCode: null, updatedAt: 1000, observedAt: 1000 }
}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.setItem('shellbeam.locale', 'en')
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(metadataSession).mockResolvedValue(4)
  vi.mocked(vaultGetSecret).mockResolvedValue('synthetic-only')
  vi.mocked(rules.readOfflineRule).mockResolvedValue(observation)
  vi.mocked(rules.saveHostRule).mockResolvedValue(intent())
  vi.mocked(rules.ruleAction).mockImplementation(async row => ({ ...row, version: row.version + 1 }))
  vi.mocked(rules.listHostRules).mockResolvedValue([])
  vi.mocked(listKomariIntegrations).mockResolvedValue([])
})
describe('native host notification editor', () => {
  it('does not add UI or read service credentials for a non-integrated host', async () => {
    const view = render(<HostNotificationRulesPanel host={host} unlocked />)
    await waitFor(() => expect(rules.listHostRules).toHaveBeenCalledWith('v'))
    expect(view.container).toBeEmptyDOMElement()
    expect(vaultGetSecret).not.toHaveBeenCalled()
    expect(rules.readOfflineRule).not.toHaveBeenCalled()
  })
  it('loads on demand and saves only the offline rule, scoped to the observed binding', async () => {
    render(<RuleEditor host={host} target={target} />)
    expect(rules.readOfflineRule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read current rule' }))
    await screen.findByRole('checkbox')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }))
    await waitFor(() => expect(rules.saveHostRule).toHaveBeenCalledTimes(1))
    expect(rules.saveHostRule).toHaveBeenCalledWith({ session: 4, vaultId: 'v', hostId: 'h', integrationId: 'i', nodeId: 'n', expectedVersion: 0, expectedMappingRevision: 3, expectedIntegrationVersion: 7, remote: observation, desired: { enabled: true, gracePeriod: 120 } })
    expect(screen.getByRole('status')).toHaveTextContent('Saved locally; awaiting verification')
    expect(screen.getByRole('status')).toHaveTextContent('one-audited-job')
    expect(JSON.stringify(vi.mocked(rules.saveHostRule).mock.calls)).not.toContain('synthetic-only')
  })
  it('rejects invalid grace periods without persisting or sending', async () => {
    render(<RuleEditor host={host} target={target} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read current rule' }))
    await screen.findByRole('spinbutton')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }))
    expect(screen.getByRole('alert')).toHaveTextContent('1 to 86400')
    expect(rules.saveHostRule).not.toHaveBeenCalled()
  })
  it('shows persisted conflict values and requires an explicit resolution', async () => {
    const row = intent('conflict')
    render(<RuleEditor host={host} target={target} saved={row} />)
    expect(screen.getByRole('status')).toHaveTextContent('My saved changes: Enabled · 120s')
    expect(screen.getByRole('status')).toHaveTextContent('Current service rule: Disabled · 180s')
    expect(rules.syncHostRules).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply my changes' }))
    await waitFor(() => expect(rules.ruleAction).toHaveBeenCalledWith(row, 'keep-local', 4))
  })
  it('allows cancelling a saved failure even if the credential has been removed', async () => {
    vi.mocked(vaultGetSecret).mockResolvedValue(null)
    const row = intent('failed')
    render(<RuleEditor host={host} target={target} saved={row} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel pending changes' }))
    await waitFor(() => expect(rules.ruleAction).toHaveBeenCalledWith(row, 'cancel', 4))
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })
  it('disables editing on an unsupported service version', async () => {
    vi.mocked(rules.readOfflineRule).mockRejectedValue(new KomariApiError('fixture', { code: 'endpoint-version' }))
    render(<RuleEditor host={host} target={target} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read current rule' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('does not support verified rule editing')
    expect(screen.queryByRole('button', { name: 'Save and verify' })).toBeNull()
    expect(rules.saveHostRule).not.toHaveBeenCalled()
  })
  it('discards a late read after the host editor unmounts', async () => {
    let resolve!: (value: rules.RuleObservation) => void
    vi.mocked(rules.readOfflineRule).mockImplementation(() => new Promise(done => { resolve = done }))
    const view = render(<RuleEditor host={host} target={target} saved={intent()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read current rule' }))
    await waitFor(() => expect(rules.readOfflineRule).toHaveBeenCalled())
    view.unmount(); resolve(observation)
    await new Promise(done => setTimeout(done, 0))
    expect(rules.ruleAction).not.toHaveBeenCalled()
    expect(rules.syncHostRules).not.toHaveBeenCalled()
  })
  it('stops a credential read after the Vault session changes', async () => {
    vi.mocked(vaultGetSecret).mockImplementation(async () => { vi.mocked(metadataSession).mockResolvedValue(5); return 'synthetic-only' })
    render(<RuleEditor host={host} target={target} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read current rule' }))
    await screen.findByRole('alert')
    expect(rules.readOfflineRule).not.toHaveBeenCalled()
    expect(rules.saveHostRule).not.toHaveBeenCalled()
  })
})
