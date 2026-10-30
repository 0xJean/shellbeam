import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { WorkspaceChartsApp } from './workspace-charts-app'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host = { id: 'h1', vaultId: 'v', name: 'web', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1 } as HostProfile

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.mocked(invoke).mockReset() })
afterEach(() => { cleanup(); localStorage.clear() })

describe('workspace charts app', () => {
  it('explains an empty history instead of drawing flat lines', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    render(<I18nProvider><WorkspaceChartsApp host={host} vaultId="v" /></I18nProvider>)
    expect(await screen.findByText(/No samples for this host/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('list_provider_metric_history', { query: expect.objectContaining({ vaultId: 'v', hostId: 'h1' }) })
  })

  it('reads the previous period only when comparing, and not beyond retention', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    render(<I18nProvider><WorkspaceChartsApp host={host} vaultId="v" /></I18nProvider>)
    await screen.findByText(/No samples for this host/)
    fireEvent.click(screen.getByTestId('workspace-charts-compare'))
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(3))
    fireEvent.click(screen.getByRole('tab', { name: '7d' }))
    expect(screen.getByTestId('workspace-charts-compare')).toBeDisabled()
  })
})
