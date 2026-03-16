import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceShell } from './workspace-shell'

vi.mock('@/lib/sessions', () => ({
  runSshCommand: vi.fn(async () => ({
    stdout: 'nginx started',
    stderr: '',
    exitCode: 0,
    durationMs: 12,
  })),
}))

describe('workspace shell', () => {
  it('renders the desktop shell when mobile is false', () => {
    render(
      <WorkspaceShell
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
  })

  it('renders the mobile shell when mobile is true', () => {
    render(
      <WorkspaceShell
        mobile
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Home Screen')).toBeInTheDocument()
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
  })

  it('routes app selection through the shared shell callbacks', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /logs/i })[0])

    expect(onSelectApp).toHaveBeenCalledWith('logs')
  })

  it('lets desktop windows close back to the desktop surface', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="services"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /close services window/i }))

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('lets mobile apps return to the home screen', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceShell
        mobile
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="files"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /back to home screen/i }))

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('renders files fallback and logs app shells when selected', async () => {
    const { rerender } = render(
      <WorkspaceShell
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="files"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
    expect(screen.getByText(/scaffolded and ready/i)).toBeInTheDocument()

    rerender(
      <WorkspaceShell
        mobile={false}
        hostName="Production API"
        hostAddress="10.0.0.15"
        hostId="host-1"
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
        activeApp="logs"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Log Sources')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run journalctl/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('nginx started')).toBeInTheDocument()
    })
  })
})
