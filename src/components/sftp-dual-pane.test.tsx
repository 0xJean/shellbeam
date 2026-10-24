import { webcrypto } from 'node:crypto'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SftpDualPane } from './sftp-dual-pane'

const localHomeDir = vi.fn()
const localListDir = vi.fn()
const sftpListDir = vi.fn()
const sftpHomeDir = vi.fn()
const fetchAndAddKnownHost = vi.fn()
const sftpDeletePath = vi.fn()
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`,
}))

vi.mock('@/lib/sftp', () => ({
  localHomeDir: () => localHomeDir(),
  localListDir: (dir: string) => localListDir(dir),
  sftpHomeDir: (payload: unknown) => sftpHomeDir(payload),
  sftpListDir: (payload: unknown) => sftpListDir(payload),
  sftpDownloadFile: vi.fn(),
  sftpUploadFile: vi.fn(),
  sftpDeletePath: (payload: unknown) => sftpDeletePath(payload),
  sftpRenamePath: vi.fn(),
  sftpCreateDir: vi.fn(),
  sftpChmod: vi.fn(),
  sftpStatPath: vi.fn(async () => ({ exists: false })),
  localReadFileB64: vi.fn(),
  localWriteFileB64: vi.fn(),
}))

vi.mock('@/lib/known-hosts', () => ({
  fetchAndAddKnownHost: (...args: unknown[]) => fetchAndAddKnownHost(...args),
}))

describe('sftp dual pane', () => {
  beforeEach(() => {
    localHomeDir.mockReset()
    localListDir.mockReset()
    sftpListDir.mockReset()
    sftpHomeDir.mockReset().mockResolvedValue('/root')
    fetchAndAddKnownHost.mockReset()
    sftpDeletePath.mockReset()
    invoke.mockReset()
    vi.stubGlobal('crypto', webcrypto)
    let jobCount = 0
    invoke.mockImplementation(async (command, payload) => {
      if (command === 'operation_job_create') return { ...payload.request, jobId: `job-${++jobCount}`, auditId: `audit-${jobCount}`, status: 'queued' }
      if (command === 'operation_job_update') return payload.request
      return null
    })

    localHomeDir.mockResolvedValue('/Users/demo')
    localListDir.mockResolvedValue([])
    sftpListDir.mockResolvedValue([])

    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver
  })

  it('auto-connects the currently selected host on mount', async () => {
    render(
      <SftpDualPane
        hosts={[
          {
            id: 'host-1',
            name: 'Production API',
            address: '10.0.0.15',
            port: 22,
            username: 'root',
            group: 'Default',
            authType: 'password',
            tags: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ]}
        selectedHostId="host-1"
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(sftpListDir).toHaveBeenCalledWith({
        host: '10.0.0.15',
        port: 22,
        username: 'root',
        authType: 'password',
        password: 'secret',
        privateKey: undefined,
        remotePath: '/root',
      })
    })
  })

  it('shows local loading immediately and lets the local pane stay usable while a remote request is pending', async () => {
    let finishLocal!: (entries: unknown[]) => void
    localListDir.mockReturnValue(new Promise(resolve => { finishLocal = resolve }))
    sftpListDir.mockReturnValue(new Promise(() => {}))
    render(<SftpDualPane hosts={[{
      id: 'a', name: 'Slow', address: '10.0.0.1', port: 22, username: 'root',
      authType: 'password', group: '', tags: [], createdAt: 0, updatedAt: 0,
    }]} selectedHostId="a" resolveAuthSecret={async () => 'test'} />)
    expect(screen.getByTestId('sftp-file-pane-skeleton')).toBeVisible()
    await waitFor(() => expect(sftpListDir).toHaveBeenCalledOnce())
    await act(async () => { finishLocal([{ path: '/Users/demo/local.txt', fileName: 'local.txt', isDir: false }]) })
    fireEvent.click(screen.getByText('local.txt'))
    expect(screen.getByText('sftpPane.selected')).toBeVisible()
    expect(sftpListDir).toHaveBeenCalledOnce()
  })

  it('resolves each account home and ignores a previous host response after switching during a slow read', async () => {
    let finishOld!: (entries: unknown[]) => void
    const profiles = ['a', 'b'].map(id => ({ id, name: id, address: `10.0.0.${id === 'a' ? 1 : 2}`, port: 22,
      username: id, authType: 'password' as const, group: '', tags: [], createdAt: 0, updatedAt: 0 }))
    sftpHomeDir.mockImplementation(async payload => `/home/${payload.username}`)
    sftpListDir.mockImplementation(payload => payload.username === 'a'
      ? new Promise(resolve => { finishOld = resolve })
      : Promise.resolve([{ path: '/home/b/current', fileName: 'current', isDir: false }]))
    render(<SftpDualPane hosts={profiles} selectedHostId="a" resolveAuthSecret={async () => 'test'} />)
    fireEvent.click(screen.getByRole('button', { name: 'sftp.remoteTab' }))
    await waitFor(() => expect(sftpListDir).toHaveBeenCalledWith(expect.objectContaining({ username: 'a', remotePath: '/home/a' })))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    expect(await screen.findByText('current')).toBeVisible()
    await act(async () => { finishOld([{ path: '/home/a/stale', fileName: 'stale', isDir: false }]) })
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    expect(screen.getByText('current')).toBeVisible()
    expect(sftpListDir).toHaveBeenCalledTimes(2)
    expect(sftpListDir).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'b', remotePath: '/home/b' }))
    sftpListDir.mockResolvedValue([{ path: '/home/a/returned', fileName: 'returned', isDir: false }])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } })
    expect(await screen.findByText('returned')).toBeVisible()
    expect(screen.queryByText('current')).not.toBeInTheDocument()
    expect(sftpListDir).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'a', remotePath: '/home/a' }))
  })

  it('reviews a multi-selection once, then creates one completed audit job per deleted target', async () => {
    sftpListDir.mockResolvedValue([
      { path: '/root/a', fileName: 'a', isDir: false }, { path: '/root/b', fileName: 'b', isDir: false },
    ])
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('DELETE')
    render(<SftpDualPane hosts={[{
      id: 'host-1', name: 'Production API', address: '10.0.0.15', port: 22, username: 'root', group: 'Default',
      authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
    }]} selectedHostId="host-1" vaultId="team" resolveAuthSecret={async () => 'secret'} />)
    fireEvent.click(screen.getByRole('button', { name: 'sftp.remoteTab' }))
    await screen.findByText('a')
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByTitle('sftpPane.delete'))
    await waitFor(() => expect(sftpDeletePath).toHaveBeenCalledTimes(2))
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('/root/a'))
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('/root/b'))
    await waitFor(() => expect(invoke.mock.calls.filter(([command, payload]) => command === 'operation_job_update' && payload.request.status === 'completed' && payload.request.resultSummary === 'verification=path-absent')).toHaveLength(2))
    expect(invoke.mock.calls.filter(([command, payload]) => command === 'operation_job_create' && payload.request.action === 'file.delete')).toHaveLength(2)
    expect(sftpDeletePath).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-1', vaultId: 'team' }))
    expect(fetchAndAddKnownHost).not.toHaveBeenCalled()
  })
})
