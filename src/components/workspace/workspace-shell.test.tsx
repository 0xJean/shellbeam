import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceShell } from './workspace-shell'

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

    expect(screen.getByText('Workspace Apps')).toBeInTheDocument()
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

    expect(screen.getByText('Server Workspace')).toBeInTheDocument()
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
})
