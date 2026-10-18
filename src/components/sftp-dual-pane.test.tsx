import { webcrypto } from 'node:crypto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SftpDualPane } from './sftp-dual-pane'

const localHomeDir = vi.fn()
const localListDir = vi.fn()
const sftpListDir = vi.fn()
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
