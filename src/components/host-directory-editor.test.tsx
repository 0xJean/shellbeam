import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostDirectoryEditor } from './host-directory-editor'
import { hostConnections, withHostConnections, type HostProfile, type HostProfileDraft } from '@/lib/hosts'
const host: HostProfile = { id: 'stable', vaultId: 'v', name: 'WEB', address: 'primary.test', port: 22, username: 'ops', authType: 'privateKey', privateKeyRef: 'keep-private', group: 'prod', tags: ['keep'], createdAt: 1, updatedAt: 2 }
beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })
describe('one native host editor', () => {
  it('stages default selection and removing the last SSH connection without deleting the host or credentials', async () => {
    const onSubmit = vi.fn<(draft: HostProfileDraft) => Promise<void>>(async () => {})
    const primary = hostConnections(host)[0]
    render(<HostDirectoryEditor host={{ ...host, ...withHostConnections(host, [primary, { ...primary, id: 'secondary', label: 'Admin', username: 'admin', privateKeyRef: 'admin-ref' }], primary.id) } as HostProfile} vaultUnlocked onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Default connection: Admin' }))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ id: 'stable', defaultConnectionId: 'secondary', username: 'admin', privateKeyRef: 'admin-ref', connections: [expect.objectContaining({ privateKeyRef: 'keep-private' }), expect.objectContaining({ privateKeyRef: 'admin-ref' })] })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove connection' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }))
    expect(screen.getByRole('status')).toHaveTextContent('Monitoring only')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0]).toMatchObject({ id: 'stable', connections: [], address: '', username: '', port: 0, tags: ['keep'] })
  })
  it('keeps the editor unsaved while the Vault is locked', () => {
    const onSubmit = vi.fn(async () => {})
    render(<HostDirectoryEditor host={host} vaultUnlocked={false} onSubmit={onSubmit} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('edits a legacy secretKeyRef connection without requiring the secret again', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<HostDirectoryEditor host={{ ...host, privateKeyRef: undefined, secretKeyRef: 'legacy-ref' }} vaultKeys={['legacy-ref']} vaultUnlocked onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'Legacy SSH' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use connection details' }))
    await screen.findByTestId('host-directory-editor')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'stable', secretKeyRef: 'legacy-ref', connections: [expect.objectContaining({ secretKeyRef: 'legacy-ref' })] }))
  })
  it('adds SSH to a monitoring-only host with the same identity and stages it before the host save', async () => {
    const onSubmit = vi.fn<(draft: HostProfileDraft) => Promise<void>>(async () => {})
    const onSaveToVault = vi.fn(async () => {})
    render(<HostDirectoryEditor host={{ ...host, ...withHostConnections(host, [], null) } as HostProfile} vaultKeys={['existing-password']} vaultUnlocked onSaveToVault={onSaveToVault} onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add SSH connection' }))
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: 'new.test' } })
    fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'Operations' } })
    fireEvent.click(screen.getByText('Select existing from Vault'))
    fireEvent.click(screen.getByRole('button', { name: 'existing-password' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use connection details' }))
    await screen.findByTestId('host-directory-editor')
    expect(onSubmit).not.toHaveBeenCalled(); expect(onSaveToVault).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ id: 'stable', name: 'WEB', address: 'new.test', passwordKeyRef: 'existing-password', connections: [expect.objectContaining({ label: 'Operations' })] })
  })
})
