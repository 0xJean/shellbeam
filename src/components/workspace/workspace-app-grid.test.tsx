import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceAppGrid } from './workspace-app-grid'

describe('workspace app grid', () => {
  it('opens the Network app using its persisted app id', () => {
    const onSelectApp = vi.fn()
    render(<WorkspaceAppGrid activeApp="overview" onSelectApp={onSelectApp} />)
    fireEvent.click(screen.getByRole('button', { name: 'Network' }))
    expect(onSelectApp).toHaveBeenCalledWith('network')
  })
  it('shows the browser app launcher entry', () => {
    render(<WorkspaceAppGrid activeApp="overview" onSelectApp={() => {}} />)
    expect(screen.getByRole('button', { name: 'Browser' })).toBeInTheDocument()
  })

  it('shows the tool manager app launcher entry', () => {
    render(<WorkspaceAppGrid activeApp="overview" onSelectApp={() => {}} />)
    expect(screen.getByRole('button', { name: 'Tool Manager' })).toBeInTheDocument()
  })

  it('shows the VPS asset inventory launcher entry', () => {
    render(<WorkspaceAppGrid activeApp="overview" onSelectApp={() => {}} />)
    expect(screen.getByRole('button', { name: 'VPS Assets' })).toBeInTheDocument()
  })
})
