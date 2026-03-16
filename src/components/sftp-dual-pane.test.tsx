import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SftpDualPane } from './sftp-dual-pane'

const localHomeDir = vi.fn()
const localListDir = vi.fn()
const sftpListDir = vi.fn()
const fetchAndAddKnownHost = vi.fn()

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/sftp', () => ({
  localHomeDir: () => localHomeDir(),
  localListDir: (dir: string) => localListDir(dir),
  sftpListDir: (payload: unknown) => sftpListDir(payload),
  sftpDownloadFile: vi.fn(),
  sftpUploadFile: vi.fn(),
  sftpDeletePath: vi.fn(),
  sftpRenamePath: vi.fn(),
  sftpCreateDir: vi.fn(),
  sftpChmod: vi.fn(),
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
})
