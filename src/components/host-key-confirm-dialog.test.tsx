import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OPEN_KNOWN_HOSTS_REQUEST_EVENT } from '@/lib/navigation-request'
import { HostKeyConfirmDialog } from './host-key-confirm-dialog'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
const listKnownHosts = vi.fn()
vi.mock('@/lib/known-hosts', () => ({ listKnownHosts: (vaultId?: string) => listKnownHosts(vaultId) }))

describe('host key confirm dialog', () => {
  it('trusts an unknown host key', () => {
    const onAccept = vi.fn()
    render(<HostKeyConfirmDialog info={{ code: 'host_key_unknown', host: '1.2.3.4', port: 22, fingerprint: 'abc', keyType: 'Rsa' }} onAccept={onAccept} onReject={vi.fn()} />)
    expect(screen.getByTestId('host-key-fingerprint')).toHaveTextContent('SHA256:abc')
    fireEvent.click(screen.getByTestId('host-key-accept'))
    expect(onAccept).toHaveBeenCalled()
  })

  it('shows recorded and received fingerprints for a changed key and links to Known Hosts', async () => {
    listKnownHosts.mockResolvedValue([{ host: '1.2.3.4', port: 22, fingerprintSha256: 'old', keyType: 'Ed25519', addedAt: 1 }])
    const onReject = vi.fn()
    const listener = vi.fn()
    window.addEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, listener)
    render(<HostKeyConfirmDialog info={{ code: 'host_key_mismatch', host: '1.2.3.4', port: 22, fingerprint: 'new', keyType: 'Ed25519', vaultId: 'vault-a' }} onAccept={vi.fn()} onReject={onReject} />)
    expect(await screen.findByTestId('host-key-old-fingerprint')).toHaveTextContent('SHA256:old')
    expect(listKnownHosts).toHaveBeenCalledWith('vault-a')
    expect(screen.getByTestId('host-key-fingerprint')).toHaveTextContent('SHA256:new')
    expect(screen.queryByTestId('host-key-accept')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View known hosts' }))
    expect(onReject).toHaveBeenCalled()
    expect(listener).toHaveBeenCalled()
    window.removeEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, listener)
  })

  it('shows only the received fingerprint when no record is available', async () => {
    listKnownHosts.mockRejectedValue(new Error('unavailable'))
    render(<HostKeyConfirmDialog info={{ code: 'host_key_mismatch', host: '1.2.3.4', port: 22, fingerprint: 'new', keyType: 'Ed25519' }} onAccept={vi.fn()} onReject={vi.fn()} />)
    await Promise.resolve()
    expect(screen.getByTestId('host-key-fingerprint')).toHaveTextContent('SHA256:new')
    expect(screen.queryByTestId('host-key-old-fingerprint')).not.toBeInTheDocument()
  })
})
