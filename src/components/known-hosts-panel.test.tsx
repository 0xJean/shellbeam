import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { KnownHostsPanel } from './known-hosts-panel'

const { listKnownHosts, removeKnownHost } = vi.hoisted(() => ({ listKnownHosts: vi.fn(), removeKnownHost: vi.fn() }))
vi.mock('@/lib/known-hosts', () => ({ listKnownHosts, removeKnownHost }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault-a' }) }))

const entries = [
  { host: '10.0.3.12', port: 22, fingerprintSha256: 'SHA256:aaa', keyType: 'ssh-ed25519', addedAt: 1_700_000_000_000 },
  { host: '203.0.113.45', port: 22, fingerprintSha256: 'SHA256:bbb', keyType: 'ssh-rsa', addedAt: 1_700_000_000_000 },
]
const hosts = [{ id: 'h1', name: 'db-master', address: '10.0.3.12', port: 22 }] as HostProfile[]

function renderPanel(props: Parameters<typeof KnownHostsPanel>[0] = {}) {
  return render(<I18nProvider><KnownHostsPanel {...props} /></I18nProvider>)
}

describe('KnownHostsPanel', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    listKnownHosts.mockReset().mockResolvedValue(entries)
    removeKnownHost.mockReset().mockResolvedValue(undefined)
  })

  it('renders records in a table and removes one', async () => {
    const onOutput = vi.fn()
    renderPanel({ onOutput })
    expect(await screen.findByText('SHA256:aaa')).toBeInTheDocument()
    expect(listKnownHosts).toHaveBeenCalledWith('vault-a')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTitle('Remove fingerprint')[0])
    await waitFor(() => expect(removeKnownHost).toHaveBeenCalledWith('vault-a', '10.0.3.12', 22))
    await waitFor(() => expect(onOutput).toHaveBeenCalledWith('Removed known host: 10.0.3.12:22'))
  })

  it('matches saved hosts and filters unassociated records', async () => {
    renderPanel({ hosts })
    expect(await screen.findByText('db-master')).toBeInTheDocument()
    const tabs = screen.getByRole('tablist', { name: 'Filter known hosts' })
    fireEvent.click(within(tabs).getByRole('tab', { name: /Unassociated/ }))
    expect(screen.queryByText('db-master')).not.toBeInTheDocument()
    expect(screen.getByText('203.0.113.45:22')).toBeInTheDocument()
    expect(screen.getByText('Not a saved host')).toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    listKnownHosts.mockResolvedValue([])
    renderPanel()
    expect(await screen.findByText('No recorded fingerprints')).toBeInTheDocument()
  })
})
