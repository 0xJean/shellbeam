import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import { listHosts, type HostProfile } from '@/lib/hosts'
import { listKomariIntegrations } from '@/lib/komari-config'
import { getKomariMappingState } from '@/lib/komari-persistence'
import { vaultGetSecret } from '@/lib/vault'
import { listHostMetadata, metadataAction, metadataSession, readRemoteHostMetadata, type HostMetadataBinding } from '@/lib/host-metadata-sync'
import { HostMetadataSyncNotice, HostMetadataSyncPanel } from './host-metadata-sync-panel'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/hosts', () => ({ listHosts: vi.fn() }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('@/lib/komari-persistence', () => ({ getKomariMappingState: vi.fn() }))
vi.mock('@/lib/vault', () => ({ vaultGetSecret: vi.fn() }))
vi.mock('@/lib/host-metadata-sync', () => ({ HOST_METADATA_CHANGED: 'metadata-changed', listHostMetadata: vi.fn(), metadataAction: vi.fn(), metadataSession: vi.fn(), notifyHostMetadataChanged: vi.fn(), readRemoteHostMetadata: vi.fn() }))

const host: HostProfile = { id: 'host', vaultId: 'v', name: 'WEB', address: 'example.test', username: 'ops', port: 22, authType: 'password', group: 'prod', tags: ['web'], createdAt: 1, updatedAt: 4 }
const service = { id: 'service', vaultId: 'v', name: 'Monitoring', endpoint: 'https://monitor.example', credentialRef: 'retained-ref', enabled: true, createdAt: 1, updatedAt: 9 }
const row: HostMetadataBinding = { id: 'binding', vaultId: 'v', hostId: host.id, integrationId: service.id, nodeId: 'node', endpoint: service.endpoint, credentialRef: service.credentialRef, integrationVersion: 9, mappingRevision: 3, identity: 'node:created', baseline: null, desired: { name: 'WEB', group: 'prod', tags: ['web'] }, remote: { name: 'Remote', group: 'prod', tags: ['web'] }, status: 'conflict', version: 4, attempts: 0, nextAttemptAt: 0, errorCode: null, conflicts: ['name'], jobId: 'existing-job', updatedAt: 1 }
const panel = (value = host, unlocked = true) => <I18nProvider><HostMetadataSyncPanel host={value} unlocked={unlocked} /></I18nProvider>

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.setItem('shellbeam.locale', 'en')
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(listHostMetadata).mockResolvedValue([])
  vi.mocked(listKomariIntegrations).mockResolvedValue([service])
  vi.mocked(getKomariMappingState).mockResolvedValue({ revision: 3, mappings: [{ integrationId: 'service', hostId: host.id, nodeId: 'node', updatedAt: 1, source: 'manual', confidence: 'explicit' }] })
  vi.mocked(listHosts).mockResolvedValue([{ ...host, vaultId: 'v' }])
  vi.mocked(vaultGetSecret).mockResolvedValue('test-secret')
  vi.mocked(metadataSession).mockResolvedValue(7)
  vi.mocked(readRemoteHostMetadata).mockResolvedValue({ identity: row.identity, values: row.remote })
})
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

describe('one native profile sync entry', () => {
  it('adds no onboarding or service card for an unlinked host', async () => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
    render(panel())
    await waitFor(() => expect(listHostMetadata).toHaveBeenCalled())
    expect(screen.queryByTestId('host-metadata-sync')).not.toBeInTheDocument()
    expect(vaultGetSecret).not.toHaveBeenCalled()
  })
  it('enables explicitly with the exact observed endpoint, configuration, mapping, host and Vault generation', async () => {
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'Enable profile sync' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('enable_host_metadata_sync', { input: { vaultId: 'v', hostId: 'host', integrationId: 'service', nodeId: 'node', expectedMappingRevision: 3, expectedIntegrationVersion: 9, expectedEndpoint: service.endpoint, expectedHostUpdatedAt: 4, session: 7, remote: { identity: row.identity, values: row.remote } } }))
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('test-secret')
  })
  it('requires a choice for each conflicting field and resolves through the existing job', async () => {
    vi.mocked(listHostMetadata).mockResolvedValue([row])
    render(panel())
    const save = await screen.findByRole('button', { name: 'Save resolution' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Service value: Remote'))
    fireEvent.click(save)
    await waitFor(() => expect(metadataAction).toHaveBeenCalledWith(row, 'resolve', 7, { choices: { name: 'remote' } }))
    expect(screen.queryByRole('button', { name: 'Enable profile sync' })).not.toBeInTheDocument()
  })
  it('keeps failed intent reachable and does not claim a rejected retry succeeded', async () => {
    vi.mocked(listHostMetadata).mockResolvedValue([{ ...row, status: 'failed', errorCode: 'permission' }])
    vi.mocked(metadataAction).mockRejectedValue(new Error('permission'))
    render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('did not complete')
    expect(screen.getByText('Needs attention')).toBeVisible()
    expect(screen.getByText('existing-job')).toBeInTheDocument()
  })
  it('drops a late enable when the Vault changes during the remote read', async () => {
    let resolve!: (value: { identity: string; values: typeof row.remote }) => void
    vi.mocked(readRemoteHostMetadata).mockReturnValue(new Promise(done => { resolve = done }))
    const view = render(panel())
    fireEvent.click(await screen.findByRole('button', { name: 'Enable profile sync' }))
    await waitFor(() => expect(readRemoteHostMetadata).toHaveBeenCalled())
    view.rerender(panel({ ...host, vaultId: 'other' }))
    await act(async () => resolve({ identity: row.identity, values: row.remote }))
    expect(invoke).not.toHaveBeenCalled()
  })
  it('returns to the same editor from pending work and hides it on locking', async () => {
    vi.mocked(listHostMetadata).mockResolvedValue([row])
    const onEdit = vi.fn()
    const notice = (unlocked: boolean) => <I18nProvider><HostMetadataSyncNotice vaultId="v" unlocked={unlocked} hosts={[host]} onEdit={onEdit} /></I18nProvider>
    const view = render(notice(true))
    fireEvent.click(await screen.findByRole('button', { name: 'WEB · Resolve conflicts' }))
    expect(onEdit).toHaveBeenCalledWith(host)
    view.rerender(notice(false))
    expect(screen.queryByTestId('host-metadata-pending')).not.toBeInTheDocument()
  })
})
