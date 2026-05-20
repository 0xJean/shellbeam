import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileSystemApp } from './workspace-file-system-app'

const sessionsContextValue = {
  browserBySession: {},
  openSessionBrowserMarkdown: vi.fn(),
  openSessionBrowserHtml: vi.fn(),
  setSessionWorkspaceApp: vi.fn(),
  setSessionMode: vi.fn(),
}

vi.mock('@/contexts/sessions-context', () => ({
  useSessions: () => sessionsContextValue,
}))

let directoryEntries = [
  { path: '/root/nginx', fileName: 'nginx', isDir: true, size: undefined, modifiedAt: undefined },
  { path: '/root/hosts', fileName: 'hosts', isDir: false, size: 128, modifiedAt: undefined },
]
const getHomeDir = vi.fn(async () => '/root')

const listDir = vi.fn(async (remotePath: string) => {
  if (remotePath === '/root') return directoryEntries
  if (remotePath === '/root/nginx') {
    return [{ path: '/root/nginx/nginx.conf', fileName: 'nginx.conf', isDir: false, size: 48, modifiedAt: undefined }]
  }
  return []
})
const createFile = vi.fn(async (remotePath: string) => {
  const fileName = remotePath.split('/').pop() || remotePath
  directoryEntries = [...directoryEntries, { path: remotePath, fileName, isDir: false, size: 0, modifiedAt: undefined }]
})
const createDir = vi.fn(async (remotePath: string) => {
  const fileName = remotePath.split('/').pop() || remotePath
  directoryEntries = [...directoryEntries, { path: remotePath, fileName, isDir: true, size: undefined, modifiedAt: undefined }]
})
const renamePath = vi.fn(async (oldRemotePath: string, newRemotePath: string) => {
  directoryEntries = directoryEntries.map((entry) => (
    entry.path === oldRemotePath
      ? { ...entry, path: newRemotePath, fileName: newRemotePath.split('/').pop() || newRemotePath }
      : entry
  ))
})
const deletePath = vi.fn(async (remotePath: string) => {
  directoryEntries = directoryEntries.filter((entry) => entry.path !== remotePath)
})
const readFile = vi.fn(async () => ({
  path: '/root/hosts',
  contentB64: btoa('127.0.0.1 localhost'),
  sizeBytes: 19,
}))
const writeFile = vi.fn(async () => {})

vi.mock('@/lib/remote-fs', () => ({
  createRemoteFsClient: () => ({
    getHomeDir,
    listDir,
    createFile,
    createDir,
    renamePath,
    deletePath,
    readFile,
    writeFile,
  }),
}))

describe('workspace file system app', () => {
  beforeEach(() => {
    directoryEntries = [
      { path: '/root/nginx', fileName: 'nginx', isDir: true, size: undefined, modifiedAt: undefined },
      { path: '/root/hosts', fileName: 'hosts', isDir: false, size: 128, modifiedAt: undefined },
    ]
    getHomeDir.mockClear()
    listDir.mockClear()
    createFile.mockClear()
    createDir.mockClear()
    renamePath.mockClear()
    deletePath.mockClear()
    readFile.mockClear()
    writeFile.mockClear()
    sessionsContextValue.openSessionBrowserMarkdown.mockReset()
    sessionsContextValue.openSessionBrowserHtml.mockReset()
    sessionsContextValue.setSessionWorkspaceApp.mockReset()
    sessionsContextValue.setSessionMode.mockReset()
    vi.restoreAllMocks()
  })

  it('renders a remote-only directory view for the selected host', async () => {
    render(
      <WorkspaceFileSystemApp
        sessionId="session-1"
        presentation="window"
        selectedHostId="host-1"
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
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByTestId('workspace-file-system-app')).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Home' })
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument()

    await waitFor(() => {
      expect(getHomeDir).toHaveBeenCalledTimes(1)
      expect(listDir).toHaveBeenCalledWith('/root')
      expect(screen.getByText('nginx')).toBeInTheDocument()
      expect(screen.getByText('hosts')).toBeInTheDocument()
    })
  })

  it('enters directories on click and shows loading immediately while the next directory loads', async () => {
    const nestedDir = {
      resolve: (_entries: typeof directoryEntries) => {},
    }
    listDir.mockImplementation(async (remotePath: string) => {
      if (remotePath === '/root') return directoryEntries
      if (remotePath === '/root/nginx') {
        return new Promise<typeof directoryEntries>((resolve) => {
          nestedDir.resolve = resolve
        })
      }
      return []
    })

    render(
      <WorkspaceFileSystemApp
        sessionId="session-1"
        presentation="window"
        selectedHostId="host-1"
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
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await screen.findByRole('button', { name: /nginx/i })
    fireEvent.click(screen.getByRole('button', { name: /nginx/i }))

    expect(screen.getByText('Loading directory...')).toBeInTheDocument()
    expect(screen.queryByText('hosts')).not.toBeInTheDocument()
    expect(listDir).toHaveBeenCalledWith('/root/nginx')

    nestedDir.resolve([
      { path: '/root/nginx/nginx.conf', fileName: 'nginx.conf', isDir: false, size: 48, modifiedAt: undefined },
    ])

    await waitFor(() => {
      expect(screen.getByText('nginx.conf')).toBeInTheDocument()
    })
  })

  it('updates the active sidebar location immediately when locations share a path', async () => {
    render(
      <WorkspaceFileSystemApp
        sessionId="session-1"
        presentation="window"
        selectedHostId="host-1"
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
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    const parentLocation = await screen.findByRole('button', { name: 'Parent' })
    const rootLocation = screen.getByRole('button', { name: 'Root' })

    expect(parentLocation).not.toHaveClass('font-medium')
    expect(rootLocation).not.toHaveClass('font-medium')

    fireEvent.click(parentLocation)
    expect(parentLocation).toHaveClass('font-medium')
    expect(rootLocation).not.toHaveClass('font-medium')

    fireEvent.click(rootLocation)
    expect(rootLocation).toHaveClass('font-medium')
    expect(parentLocation).not.toHaveClass('font-medium')

    await waitFor(() => {
      expect(screen.getByText('This directory is empty.')).toBeInTheDocument()
    })
  })

  it('creates, renames, and deletes remote entries', async () => {
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('notes.txt')
      .mockReturnValueOnce('configs')
      .mockReturnValueOnce('hosts.bak')
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <WorkspaceFileSystemApp
        sessionId="session-1"
        presentation="window"
        selectedHostId="host-1"
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
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await screen.findByText('hosts')

    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    await waitFor(() => {
      expect(createFile).toHaveBeenCalledWith('/root/notes.txt')
      expect(screen.getByText('notes.txt')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))

    await waitFor(() => {
      expect(createDir).toHaveBeenCalledWith('/root/configs')
      expect(screen.getByText('configs')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /hosts/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => {
      expect(renamePath).toHaveBeenCalledWith('/root/hosts', '/root/hosts.bak')
      expect(screen.getByText('hosts.bak')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /hosts\.bak/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deletePath).toHaveBeenCalledWith('/root/hosts.bak')
      expect(screen.queryByText('hosts.bak')).not.toBeInTheDocument()
    })
  })

  it('previews markdown files in the shared browser flow', async () => {
    directoryEntries = [
      { path: '/root/readme.md', fileName: 'readme.md', isDir: false, size: 16, modifiedAt: undefined },
    ]
    readFile.mockResolvedValueOnce({
      path: '/root/readme.md',
      contentB64: btoa('# Hello\n\n- world'),
      sizeBytes: 16,
    })

    render(
      <WorkspaceFileSystemApp
        sessionId="session-1"
        presentation="window"
        selectedHostId="host-1"
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
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await screen.findByRole('button', { name: /readme\.md/i })
    fireEvent.click(screen.getByRole('button', { name: /readme\.md/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => {
      expect(sessionsContextValue.openSessionBrowserMarkdown).toHaveBeenCalledWith('session-1', '# Hello\n\n- world', expect.objectContaining({ title: 'readme.md', presentation: 'window' }))
      expect(sessionsContextValue.setSessionWorkspaceApp).toHaveBeenCalledWith('session-1', 'browser')
      expect(sessionsContextValue.setSessionMode).toHaveBeenCalledWith('session-1', 'workspace')
    })
  })
})
