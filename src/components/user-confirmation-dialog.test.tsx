import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserConfirmationDialog } from './user-confirmation-dialog'
import { confirmUserAction } from '@/lib/user-confirmation'
import type { HostProfile } from '@/lib/hosts'
import { runConfirmedOperation } from '@/lib/operation-job'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const jump: HostProfile = { id: 'jump', vaultId: 'vault-a', name: 'Jump', address: 'jump.example', port: 22, username: 'ops', authType: 'privateKey', privateKeyRef: 'jump-key', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 }
const host: HostProfile = { ...jump, id: 'host', name: 'Target', address: 'host.example', privateKeyRef: 'target-key', jumpHostId: 'jump' }
const props = { vaultId: 'vault-a', unlocked: true, hosts: [host, jump] }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function request(overrides = {}) {
  let pending!: Promise<boolean>
  await act(async () => { pending = confirmUserAction({ message: 'Restart nginx.service on Target?', host, vaultId: 'vault-a', risk: 'high', ...overrides }) })
  return { pending }
}

describe('visible operation consent', () => {
  it('keeps the caller pending until an actual click, starts with Cancel focused, and accepts only once', async () => {
    const native = vi.spyOn(window, 'confirm')
    render(<UserConfirmationDialog {...props} />)
    const { pending } = await request()
    expect(screen.getByTestId('user-confirmation-message')).toHaveTextContent('nginx.service on Target')
    expect(screen.getByTestId('user-confirmation')).toHaveAttribute('data-host-id', host.id)
    expect(screen.getByTestId('user-confirmation-cancel')).toHaveFocus()
    let done = false
    void pending.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    fireEvent.click(screen.getByTestId('user-confirmation-accept'))
    expect(await pending).toBe(true)
    expect(screen.queryByTestId('user-confirmation')).not.toBeInTheDocument()
    expect(native).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'escape', 'backdrop', 'unmount'])('treats %s as cancellation', async mode => {
    const view = render(<UserConfirmationDialog {...props} />)
    const { pending } = await request()
    if (mode === 'unmount') view.unmount()
    else if (mode === 'cancel') fireEvent.click(screen.getByTestId('user-confirmation-cancel'))
    else if (mode === 'escape') fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }))
    else fireEvent.click(screen.getByRole('dialog'))
    expect(await pending).toBe(false)
  })

  it('requires the exact destructive file token and clears it for the next operation', async () => {
    render(<UserConfirmationDialog {...props} />)
    const first = await request({ token: 'DELETE' })
    const accept = screen.getByTestId('user-confirmation-accept')
    expect(accept).toBeDisabled()
    fireEvent.change(screen.getByTestId('user-confirmation-token'), { target: { value: 'delete' } })
    expect(accept).toBeDisabled()
    fireEvent.change(screen.getByTestId('user-confirmation-token'), { target: { value: 'DELETE' } })
    fireEvent.click(accept)
    expect(await first.pending).toBe(true)
    const second = await request({ token: 'DELETE' })
    expect(screen.getByTestId('user-confirmation-token')).toHaveValue('')
    fireEvent.click(screen.getByTestId('user-confirmation-cancel'))
    expect(await second.pending).toBe(false)
  })

  it.each(['lock', 'vault', 'host', 'jump', 'deleted'])('invalidates pending consent when %s changes', async change => {
    const view = render(<UserConfirmationDialog {...props} />)
    const { pending } = await request()
    const next = change === 'lock' ? { ...props, unlocked: false }
      : change === 'vault' ? { ...props, vaultId: 'vault-b' }
        : change === 'host' ? { ...props, hosts: [{ ...host, address: 'changed.example' }, jump] }
          : change === 'jump' ? { ...props, hosts: [host, { ...jump, privateKeyRef: 'rotated' }] }
            : { ...props, hosts: [jump] }
    await act(async () => { view.rerender(<UserConfirmationDialog {...next} />) })
    expect(await pending).toBe(false)
    expect(screen.queryByTestId('user-confirmation')).not.toBeInTheDocument()
  })

  it('rejects initial wrong scope and concurrent requests without queuing another prompt', async () => {
    render(<UserConfirmationDialog {...props} />)
    expect(await confirmUserAction({ message: 'Other Vault', vaultId: 'vault-b' })).toBe(false)
    expect(await confirmUserAction({ message: 'Old host', host: { ...host, address: 'old.example' } })).toBe(false)
    const first = await request()
    expect(await confirmUserAction({ message: 'Another operation' })).toBe(false)
    expect(screen.getByTestId('user-confirmation-message')).toHaveTextContent('nginx.service')
    fireEvent.click(screen.getByTestId('user-confirmation-cancel'))
    expect(await first.pending).toBe(false)
    expect(screen.queryByTestId('user-confirmation')).not.toBeInTheDocument()
  })

  it('observes external scope invalidation while the confirmation stays open', async () => {
    let current = true
    render(<UserConfirmationDialog {...props} />)
    const { pending } = await request({ isCurrent: () => current })
    current = false
    await waitFor(() => expect(screen.queryByTestId('user-confirmation')).not.toBeInTheDocument())
    expect(await pending).toBe(false)
  })

  it.each(['jump-edit', 'unmount'])('retains its scope guard after acceptance across the running-job await: %s', async change => {
    let markRunning!: () => void
    const running = new Promise<void>(resolve => { markRunning = resolve })
    const queued = { jobId: 'consented-job', auditId: 'consented-audit', status: 'queued', confirmationStatus: 'pending' }
    invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === 'operation_job_create') return queued
      if (args.request.status === 'running') await running
      return { ...queued, ...args.request }
    })
    const view = render(<UserConfirmationDialog {...props} />)
    const execute = vi.fn()
    let execution!: ReturnType<typeof runConfirmedOperation>
    await act(async () => {
      execution = runConfirmedOperation({ host, vaultId: props.vaultId, risk: 'high', action: 'service.restart', target: 'nginx.service', confirmMessage: 'Restart?', execute })
    })
    fireEvent.click(screen.getByTestId('user-confirmation-accept'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'running', confirmationStatus: 'confirmed' }) }))
    if (change === 'unmount') view.unmount()
    else view.rerender(<UserConfirmationDialog {...props} hosts={[host, { ...jump, address: 'changed.example' }]} />)
    await act(async () => { markRunning(); expect(await execution).toBeNull() })
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' }) })
  })
})
