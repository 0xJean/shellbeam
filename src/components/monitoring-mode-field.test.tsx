import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MonitoringModeField } from './monitoring-mode-field'
import { HostForm } from './host-form'
import { HostDirectoryEditor } from './host-directory-editor'
import { requestUserDecision } from '@/lib/user-confirmation'
import type { HostProfile } from '@/lib/hosts'

vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: vi.fn() }))
const host: HostProfile = { id: 'h', vaultId: 'v', name: 'WEB', address: 'fixture.invalid', port: 22, username: 'ops', authType: 'privateKey', privateKeyRef: 'keep', group: 'prod', tags: ['keep'], createdAt: 1, updatedAt: 2, monitoringMode: 'server' }
beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.resetAllMocks() })
describe('explicit monitoring choice', () => {
  it('defaults a new host to SSH, stages only accepted server consent and does not save or install anything', async () => {
    const save = vi.fn()
    render(<HostForm vaultId="v" vaultUnlocked onSubmit={save} onCancel={() => {}} />)
    const ssh = screen.getByRole('radio', { name: 'SSH agentless scanning' })
    const server = screen.getByRole('radio', { name: 'ShellBeam Server + owned probe' })
    expect(ssh).toBeChecked(); expect(requestUserDecision).not.toHaveBeenCalled()
    vi.mocked(requestUserDecision).mockResolvedValueOnce({ accepted: false, reason: 'rejected' })
    fireEvent.click(server)
    await waitFor(() => expect(server).toBeEnabled()); expect(ssh).toBeChecked()
    vi.mocked(requestUserDecision).mockResolvedValueOnce({ accepted: true, reason: 'accepted' })
    fireEvent.click(server)
    await waitFor(() => expect(server).toBeChecked())
    expect(requestUserDecision).toHaveBeenLastCalledWith(expect.objectContaining({ vaultId: 'v', message: expect.stringContaining('installation requires separate confirmation') }))
    expect(save).not.toHaveBeenCalled()
  })
  it('ignores consent from another scope or an invalidated confirmation', async () => {
    let finish!: (value: Awaited<ReturnType<typeof requestUserDecision>>) => void
    vi.mocked(requestUserDecision).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const change = vi.fn()
    const view = render(<MonitoringModeField value="ssh" onChange={change} scopeKey="v:h" />)
    fireEvent.click(screen.getByRole('radio', { name: 'ShellBeam Server + owned probe' }))
    view.rerender(<MonitoringModeField value="ssh" onChange={change} scopeKey="other:h" />)
    await act(async () => finish({ accepted: true, reason: 'accepted' }))
    expect(change).not.toHaveBeenCalled()
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: true, reason: 'accepted', isCurrent: () => false })
    fireEvent.click(screen.getByRole('radio', { name: 'ShellBeam Server + owned probe' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'SSH agentless scanning' })).toBeEnabled())
    expect(change).not.toHaveBeenCalled()
  })
  it('preserves server selection and credentials, requires consent to stage SSH and saves the same host', async () => {
    const save = vi.fn(async () => {})
    vi.mocked(requestUserDecision).mockResolvedValue({ accepted: true, reason: 'accepted' })
    render(<HostDirectoryEditor host={host} vaultUnlocked onSubmit={save} onCancel={() => {}} />)
    expect(screen.getByRole('radio', { name: 'ShellBeam Server + owned probe' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'SSH agentless scanning' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'SSH agentless scanning' })).toBeChecked())
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(/Remote probes and server notifications keep running/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'h', monitoringMode: 'ssh', privateKeyRef: 'keep', tags: ['keep'], createdAt: 1 })))
  })
})
