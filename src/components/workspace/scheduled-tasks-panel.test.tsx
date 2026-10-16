import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScheduledTasksPanel } from './scheduled-tasks-panel'

describe('ScheduledTasksPanel', () => {
  it('renders the scheduled task surface', () => {
    localStorage.clear()
    render(<ScheduledTasksPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={async () => ''} />)
    expect(screen.getByTestId('scheduled-tasks-panel')).toBeInTheDocument()
  })
})
