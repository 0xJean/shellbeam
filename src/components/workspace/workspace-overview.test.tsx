import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceModeToggle } from './workspace-mode-toggle'
import { WorkspaceOverview } from './workspace-overview'

describe('workspace mode toggle', () => {
  it('renders terminal and workspace options and calls onChange', () => {
    const onChange = vi.fn()

    render(<WorkspaceModeToggle mode="terminal" onChange={onChange} />)

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    expect(onChange).toHaveBeenCalledWith('workspace')
  })
})

describe('workspace overview', () => {
  it('shows the workspace app launcher and status cards', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Production API')).toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /files/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /logs/i })).toBeInTheDocument()
  })

  it('shows recent activity entries when available', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
        activityItems={[
          { id: '1', label: 'Restarted nginx', detail: '2m ago' },
        ]}
      />,
    )

    expect(screen.getByText('Restarted nginx')).toBeInTheDocument()
    expect(screen.getByText('2m ago')).toBeInTheDocument()
  })

  it('navigates to a selected workspace app', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /services/i }))

    expect(onSelectApp).toHaveBeenCalledWith('services')
  })

  it('renders recommendations from rule-based helpers', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
        recommendations={[
          { id: 'disk', title: 'Disk is getting full', targetApp: 'files' },
        ]}
      />,
    )

    expect(screen.getByText('Disk is getting full')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open files/i })).toBeInTheDocument()
  })
})
