import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariMappingsPanel } from './komari-mappings-panel'
import { listKomariIntegrations } from '@/lib/komari-config'
import { listKomariClients, type KomariClient } from '@/lib/komari'
import { editKomariMapping, getKomariMappingState, type KomariMappingState } from '@/lib/komari-persistence'
import type { HostProfile } from '@/lib/hosts'
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('@/lib/komari', () => ({ listKomariClients: vi.fn() }))
vi.mock('@/lib/komari-persistence', async (original) => ({ ...(await original<typeof import('@/lib/komari-persistence')>()), editKomariMapping: vi.fn(), getKomariMappingState: vi.fn() }))

const hosts: HostProfile[] = ['first', 'second'].map((name) => ({ id: name, name, vaultId: 'a', address: '10.0.0.1', username: 'ops', port: 22, authType: 'password', group: '', tags: [], createdAt: 0, updatedAt: 0 }))
const node: KomariClient = { uuid: 'node-1', name: 'Node One', hostname: 'node', ipv4: '10.0.0.1', ipv6: null, os: null, kernel: null, version: null, raw: {} }
let durable: KomariMappingState
const secret = vi.fn<(key: string) => Promise<string>>(async () => 'secret')
function panel(vaultId = 'a', profiles = hosts) { return <KomariMappingsPanel activeVaultId={vaultId} hosts={profiles} vaultUnlocked onLoadVaultSecret={secret} /> }
async function openPanel() {
  fireEvent.click(screen.getByText('Komari node mappings'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover nodes' })).toBeEnabled())
}
beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.clearAllMocks()
  durable = { mappings: [], revision: 0 }
  vi.mocked(listKomariIntegrations).mockImplementation(async (vaultId) => [{ id: `server-${vaultId}`, name: `Server ${vaultId}`, vaultId, endpoint: 'https://komari.test', credentialRef: `token-${vaultId}`, enabled: true, createdAt: 0, updatedAt: 0 }])
  vi.mocked(listKomariClients).mockResolvedValue([node])
  vi.mocked(getKomariMappingState).mockImplementation(async () => structuredClone(durable))
  vi.mocked(editKomariMapping).mockImplementation(async (request) => {
    if (request.expectedRevision !== durable.revision) throw new Error('KOMARI_MAPPING_CONFLICT')
    durable = { revision: durable.revision + 1, mappings: request.hostId ? [{ integrationId: request.integrationId, hostId: request.hostId, nodeId: request.nodeId, source: 'manual', confidence: 'explicit', updatedAt: 1 }] : [] }
    return structuredClone(durable)
  })
  secret.mockReset().mockResolvedValue('secret')
})

describe('Komari manual mapping workflow', () => {
  it('resolves an address conflict, retains the manual choice after remount and address changes, then explicitly returns to automatic matching', async () => {
    const view = render(panel())
    await openPanel()
    expect(await screen.findByText('Address matches multiple hosts; choose one explicitly.')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Host: Server a / node-1'), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save binding' }))
    await waitFor(() => expect(durable.revision).toBe(1))
    expect(editKomariMapping).toHaveBeenCalledWith({ vaultId: 'a', integrationId: 'server-a', nodeId: 'node-1', hostId: 'second', expectedRevision: 0 })
    view.unmount()
    render(panel('a', [hosts[0], { ...hosts[1], address: '10.0.0.9' }]))
    await openPanel()
    expect(await screen.findByText('Manual binding · second')).toBeVisible()
    expect(screen.getByLabelText('Host: Server a / node-1')).toHaveValue('second')
    fireEvent.click(screen.getByRole('button', { name: 'Return to automatic' }))
    expect(await screen.findByText('Address match · first')).toBeVisible()
    expect(editKomariMapping).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: null, expectedRevision: 1 }))
  })

  it('excludes foreign Vault hosts and disables a host already manually reserved by another node', async () => {
    durable.mappings = [{ integrationId: 'server-a', hostId: 'first', nodeId: 'node-2', source: 'manual', confidence: 'explicit', updatedAt: 1 }]
    render(panel('a', [...hosts, { ...hosts[0], vaultId: 'b', id: 'foreign', name: 'Foreign host' }]))
    await openPanel()
    const control = await screen.findByLabelText('Host: Server a / node-1')
    expect(within(control).queryByRole('option', { name: /Foreign/ })).not.toBeInTheDocument()
    expect(within(control).getByRole('option', { name: /first.*already manually bound/ })).toBeDisabled()
    expect(screen.getByText('Node absent from the latest discovery; manual binding is retained.')).toBeVisible()
  })

  it('keeps saved choices visible during discovery failure and makes a stale revision require an explicit refresh', async () => {
    durable = { revision: 2, mappings: [{ integrationId: 'server-a', hostId: 'second', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 }] }
    vi.mocked(listKomariClients).mockRejectedValue(new Error('remote secret output'))
    render(panel())
    await openPanel()
    expect(await screen.findByText('Saved node; current discovery is unavailable.')).toBeVisible()
    durable.revision++
    fireEvent.click(screen.getByRole('button', { name: 'Return to automatic' }))
    expect(await screen.findByText('Mappings changed in another session. Discover nodes again before saving.')).toBeVisible()
    expect(screen.queryByText(/remote secret output/)).not.toBeInTheDocument()
    expect(screen.getByText('Manual binding · second')).toBeVisible()
  })

  it('does not issue an old-Vault discovery after its credential read completes late', async () => {
    let finishOld!: (value: string) => void
    secret.mockImplementation((key) => key === 'token-a' ? new Promise<string>((resolve) => { finishOld = resolve }) : Promise.resolve('new-secret'))
    const view = render(panel())
    fireEvent.click(screen.getByText('Komari node mappings'))
    await waitFor(() => expect(secret).toHaveBeenCalledWith('token-a'))
    view.rerender(panel('b', hosts.map((host) => ({ ...host, vaultId: 'b' }))))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Server b' })).toBeVisible())
    await act(async () => { finishOld('old-secret') })
    expect(listKomariClients).toHaveBeenCalledTimes(1)
    expect(listKomariClients).toHaveBeenCalledWith({ endpoint: 'https://komari.test', token: 'new-secret' })
    expect(screen.queryByRole('region', { name: 'Server a' })).not.toBeInTheDocument()
  })
})
