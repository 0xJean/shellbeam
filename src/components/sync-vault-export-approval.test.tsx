import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return Promise.resolve(() => listeners.delete(name))
  }),
}))
vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: (key: string) => key }) }))

import { SyncVaultExportApproval } from './sync-vault-export-approval'

function ask(requestId = 'r1', expiresAt = Date.now() + 60_000) {
  act(() => listeners.get('sync-vault-export-approval')!({
    payload: { requestId, peerDeviceId: 'p', peerName: 'Phone', vaultId: 'v', vaultName: 'Personal', expiresAt },
  }))
}

describe('SyncVaultExportApproval', () => {
  beforeEach(() => { invoke.mockClear(); HTMLDialogElement.prototype.showModal ??= vi.fn() })

  it('shows nothing until a peer asks', () => {
    render(<SyncVaultExportApproval />)
    expect(screen.queryByText('sync.vaultExportTitle')).toBeNull()
  })

  it('sends an approval only from the allow button', () => {
    render(<SyncVaultExportApproval />)
    ask()
    fireEvent.click(screen.getByText('sync.vaultExportAllow'))
    expect(invoke).toHaveBeenCalledWith('sync_resolve_vault_export', { payload: { requestId: 'r1', approved: true } })
    expect(screen.queryByText('sync.vaultExportTitle')).toBeNull()
  })

  it('denies from the deny button', () => {
    render(<SyncVaultExportApproval />)
    ask()
    fireEvent.click(screen.getByText('sync.vaultExportDeny'))
    expect(invoke).toHaveBeenCalledWith('sync_resolve_vault_export', { payload: { requestId: 'r1', approved: false } })
  })

  it('denies when time runs out', () => {
    vi.useFakeTimers()
    try {
      render(<SyncVaultExportApproval />)
      ask('r2', Date.now() + 1000)
      expect(invoke).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1000) })
      expect(invoke).toHaveBeenCalledWith('sync_resolve_vault_export', { payload: { requestId: 'r2', approved: false } })
    } finally {
      vi.useRealTimers()
    }
  })
})
