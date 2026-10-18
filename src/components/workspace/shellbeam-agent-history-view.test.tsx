import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getShellbeamAgentHistoryCursor, publishShellbeamAgentHistorySummary, type ShellbeamAgentHistoryCursor, type ShellbeamAgentHistorySyncSummary } from '@/lib/shellbeam-agent-history'
import { ShellbeamAgentHistoryView } from './shellbeam-agent-history-view'
vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: (key: string, params?: object) => `${key}${params ? JSON.stringify(params) : ''}` }) }))
vi.mock('@/lib/shellbeam-agent-history', async (original) => ({ ...await original<typeof import('@/lib/shellbeam-agent-history')>(), getShellbeamAgentHistoryCursor: vi.fn() }))
const saved: ShellbeamAgentHistoryCursor = { cursor: '1800000000000', revision: 4, updatedAt: 1800000001000, exhausted: true, reason: 'complete' }
const summary = (vaultId: string, status: ShellbeamAgentHistorySyncSummary['status'] = 'partial'): ShellbeamAgentHistorySyncSummary => ({ vaultId, hostId: 'same', providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: 'node', status, reason: status === 'failed' ? 'invalid-page' : 'page-budget', imported: 3, pages: 1, hasMore: status === 'partial', cursor: saved.cursor })
beforeEach(() => vi.mocked(getShellbeamAgentHistoryCursor).mockReset().mockResolvedValue(saved))
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('Scoped Agent catch-up diagnostics', () => {
  it('loads durable progress independently of this session counts and displays safe partial/failure reasons', async () => {
    render(<ShellbeamAgentHistoryView vaultId="view-a" hostId="same" nodeId="node" />)
    await waitFor(() => expect(getShellbeamAgentHistoryCursor).toHaveBeenCalledWith('view-a', 'same', 'node'))
    await waitFor(() => expect(screen.queryByText(/history.loading/)).not.toBeInTheDocument())
    expect(screen.getByText(/history.status.not-started/)).toBeInTheDocument()
    await act(async () => { publishShellbeamAgentHistorySummary(summary('view-a')) })
    expect(screen.getByText(/history.status.partial/)).toBeInTheDocument()
    expect(screen.getByText(/history.counts/)).toHaveTextContent('"imported":3,"pages":1')
    expect(screen.getByText(/history.continues/)).toBeInTheDocument()
    await act(async () => { publishShellbeamAgentHistorySummary(summary('view-a', 'failed')) })
    expect(screen.getByText(/history.status.failed/)).toBeInTheDocument()
    expect(screen.getByText(/history.reason.invalid-page/)).toBeInTheDocument()
  })
  it('cannot show another Vault/node session or a late previous-scope cursor after switching', async () => {
    let finishA!: (value: ShellbeamAgentHistoryCursor) => void
    vi.mocked(getShellbeamAgentHistoryCursor).mockImplementation(async (vault) => vault === 'old-vault' ? new Promise((resolve) => { finishA = resolve }) : { ...saved, cursor: null })
    publishShellbeamAgentHistorySummary(summary('old-vault'))
    const view = render(<ShellbeamAgentHistoryView vaultId="old-vault" hostId="same" nodeId="node" />)
    expect(screen.getByText(/history.status.partial/)).toBeInTheDocument()
    view.rerender(<ShellbeamAgentHistoryView vaultId="new-vault" hostId="same" nodeId="node" />)
    expect(screen.queryByText(/history.status.partial/)).not.toBeInTheDocument()
    await act(async () => { finishA(saved) })
    await waitFor(() => expect(screen.getByText(/history.none/)).toBeInTheDocument())
    act(() => publishShellbeamAgentHistorySummary(summary('old-vault', 'failed')))
    act(() => publishShellbeamAgentHistorySummary({ ...summary('new-vault'), nodeId: 'other-node' }))
    expect(screen.queryByText(/history.status.failed|history.status.partial/)).not.toBeInTheDocument()
  })
})
