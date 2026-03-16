import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceModeToggle } from './workspace-mode-toggle'

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
