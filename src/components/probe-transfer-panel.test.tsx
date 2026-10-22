import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import * as api from '@/lib/compatible-agent'
import { requestUserDecision } from '@/lib/user-confirmation'
import { ProbeTransferPanel } from './probe-transfer-panel'
import { probeTransferCopy } from '@/lib/locales/probe-transfer'
const scope = vi.hoisted(() => ({ generation: 0, capture: () => { const g = scope.generation; return () => g === scope.generation } }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault', captureVaultScope: scope.capture }) }))
vi.mock('@/lib/compatible-agent', () => ({ cancelCompatibleAgent: vi.fn(), operateProbeTransfer: vi.fn(), prepareProbeTransfer: vi.fn(), probeTransferDestinations: vi.fn(), readProbeTransfer: vi.fn(), recoverProbeTransfer: vi.fn() }))
vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: vi.fn() }))
const c = probeTransferCopy.en
const end = { hostName: 'Origin', account: 'runner', transport: 'ssh-proxyjump', serviceScope: 'user', endpoint: 'https://source.test', nodeId: 'source-node', dataDirectory: '/home/runner/managed', currentVersion: '1.5.11', targetVersion: '1.5.11' } as api.CompatibleAgentPreview
const preview: api.ProbeTransferPreview = { planId: 'plan', action: 'move', source: end, target: { ...end, hostName: 'Destination', account: 'root', nodeId: 'target-node', endpoint: 'https://target.test', serviceScope: 'system' } }
const row = { id: 'migration', status: 'unknown', jobId: 'job', errorCode: null, sourceState: { active: false }, targetState: { active: true } } as api.ProbeTransfer
const changed = vi.fn(); const pending = vi.fn()
const mount = () => render(<I18nProvider><ProbeTransferPanel vaultId="vault" hostId="source" canMove onChanged={changed} onPending={pending} /></I18nProvider>)
beforeEach(() => { scope.generation++; localStorage.setItem('shellbeam.locale', 'en'); vi.mocked(api.readProbeTransfer).mockResolvedValue(null); vi.mocked(api.cancelCompatibleAgent).mockResolvedValue(); vi.mocked(api.prepareProbeTransfer).mockResolvedValue(preview); vi.mocked(api.recoverProbeTransfer).mockResolvedValue(preview); vi.mocked(api.operateProbeTransfer).mockImplementation(async () => { const result = { ...row, status: 'completed' }; vi.mocked(api.readProbeTransfer).mockResolvedValue(result); return result }); vi.mocked(requestUserDecision).mockResolvedValue({ accepted: true, reason: 'accepted' }); vi.mocked(api.probeTransferDestinations).mockResolvedValue([{ hostId: 'target', hostName: 'Destination', connectionId: 'alternate', connectionName: 'Operations', account: 'root', address: 'target.test', integrationId: 'target-service', serviceName: 'Monitoring', nodeId: 'target-node', endpoint: 'https://target.test' }]) })
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })
async function choose() { fireEvent.click(screen.getByText(c.title)); fireEvent.click(screen.getByRole('button', { name: c.load })); fireEvent.change(await screen.findByLabelText(c.target), { target: { value: '0' } }) }
it('uses saved target connection and shows both identities before dispatch', async () => {
  mount(); await choose(); fireEvent.click(screen.getByRole('button', { name: c.move })); await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(api.prepareProbeTransfer).toHaveBeenCalledExactlyOnceWith({ vaultId: 'vault', sourceHostId: 'source', targetHostId: 'target', targetConnectionId: 'alternate', targetIntegrationId: 'target-service' })
  const message = vi.mocked(requestUserDecision).mock.calls[0][0].message; for (const value of ['Origin', 'Destination', 'source-node', 'target-node', 'runner', 'root', 'ssh-proxyjump', 'https://target.test', c.confirm]) expect(message).toContain(value)
  expect(api.operateProbeTransfer).toHaveBeenCalledExactlyOnceWith('plan', true); expect(api.cancelCompatibleAgent).toHaveBeenCalledWith('plan')
})
it('does not enumerate targets or execute on mount and restores pending audit across sessions', async () => {
  vi.mocked(api.readProbeTransfer).mockResolvedValue(row); mount(); await screen.findByText(c.pending); fireEvent.click(screen.getByText(c.title))
  expect(api.probeTransferDestinations).not.toHaveBeenCalled(); expect(api.operateProbeTransfer).not.toHaveBeenCalled(); expect(pending).toHaveBeenCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: c.inspect })); await waitFor(() => expect(api.operateProbeTransfer).toHaveBeenCalledExactlyOnceWith('plan', false)); expect(requestUserDecision).not.toHaveBeenCalled()
  expect(api.recoverProbeTransfer).toHaveBeenCalledExactlyOnceWith('vault', 'migration', 'inspect')
})
it.each(['restore', 'finish'] as const)('requires a new confirmation for %s', async action => {
  vi.mocked(api.readProbeTransfer).mockResolvedValue(row); vi.mocked(requestUserDecision).mockResolvedValue({ accepted: false, reason: 'rejected' }); mount(); await screen.findByText(c.pending); fireEvent.click(screen.getByText(c.title)); fireEvent.click(screen.getByRole('button', { name: c[action] }))
  await waitFor(() => expect(api.cancelCompatibleAgent).toHaveBeenCalledWith('plan')); expect(api.recoverProbeTransfer).toHaveBeenCalledExactlyOnceWith('vault', 'migration', action); expect(api.operateProbeTransfer).not.toHaveBeenCalled()
})
it('revokes a late plan after Vault changed and prevents duplicate clicks', async () => {
  let resolve!: (p: api.ProbeTransferPreview) => void; vi.mocked(api.prepareProbeTransfer).mockImplementation(() => new Promise(done => { resolve = done }))
  mount(); await choose(); fireEvent.click(screen.getByRole('button', { name: c.move })); await waitFor(() => expect(resolve).toBeTypeOf('function')); expect(screen.getByRole('button', { name: c.move })).toBeDisabled(); scope.generation++
  await act(async () => { resolve(preview) }); expect(api.operateProbeTransfer).not.toHaveBeenCalled(); expect(requestUserDecision).not.toHaveBeenCalled(); expect(api.cancelCompatibleAgent).toHaveBeenCalledWith('plan')
})

it('refreshes durable recovery state on a matching endpoint event without replay', async () => {
  mount(); await act(async () => {}); vi.mocked(api.readProbeTransfer).mockResolvedValue(row)
  await act(async () => { window.dispatchEvent(new CustomEvent('shellbeam:probe-deployment-changed', { detail: { vaultId: 'vault', hostIds: ['source'] } })) })
  expect(await screen.findByText(c.pending)).toBeInTheDocument(); expect(pending).toHaveBeenCalledWith(true); expect(api.operateProbeTransfer).not.toHaveBeenCalled()
})

it('keeps recovery visible on a failed durable read and only retries reading', async () => {
  vi.mocked(api.readProbeTransfer).mockRejectedValueOnce(new Error('storage unavailable'))
  mount(); await screen.findByText(c.readFailed); fireEvent.click(screen.getByText(c.title))
  expect(pending).toHaveBeenCalledWith(true); expect(screen.queryByRole('button', { name: c.load })).not.toBeInTheDocument()
  vi.mocked(api.readProbeTransfer).mockResolvedValue(row);fireEvent.click(screen.getByRole('button',{name:c.reload}));await screen.findByText(c.pending)
  expect(api.operateProbeTransfer).not.toHaveBeenCalled();expect(api.prepareProbeTransfer).not.toHaveBeenCalled()
})
it('refreshes source and destination when recovery is initiated from the target host', async () => {
  const result = { ...row, status: 'restored', source: { record: { hostId: 'origin' } }, target: { record: { hostId: 'source' } } } as api.ProbeTransfer
  vi.mocked(api.readProbeTransfer).mockResolvedValue(row);vi.mocked(api.operateProbeTransfer).mockResolvedValue(result)
  const events: CustomEvent[] = []; const listener = (event: Event) => events.push(event as CustomEvent)
  window.addEventListener('shellbeam:probe-deployment-changed', listener)
  try {
    mount();await screen.findByText(c.pending);fireEvent.click(screen.getByText(c.title));fireEvent.click(screen.getByRole('button',{name:c.restore}));await waitFor(()=>expect(events).toHaveLength(1))
    expect(new Set(events[0].detail.hostIds)).toEqual(new Set(['origin','source']));expect(events[0].detail.vaultId).toBe('vault')
  } finally {window.removeEventListener('shellbeam:probe-deployment-changed',listener)}
})
it('reads a durable interrupted intent after a lost operation response without resending', async () => {
  vi.mocked(api.operateProbeTransfer).mockImplementation(async () => { vi.mocked(api.readProbeTransfer).mockResolvedValue(row); throw new Error('connection lost') })
  mount();await choose();fireEvent.click(screen.getByRole('button',{name:c.move}));await screen.findByText(c.pending)
  expect(api.operateProbeTransfer).toHaveBeenCalledExactlyOnceWith('plan',true);expect(pending).toHaveBeenCalledWith(true)
  expect(screen.queryByRole('button',{name:c.move})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:c.inspect})).toBeEnabled()
})
