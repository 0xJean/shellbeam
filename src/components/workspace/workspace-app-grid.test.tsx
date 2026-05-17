import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkspaceAppGrid } from './workspace-app-grid'

describe('workspace app grid', () => {
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
