import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionCloseDialog } from './session-close-dialog'

const tabs = [
  { id: '1', title: 'Grafana', url: 'http://127.0.0.1:3000', routeIndicator: { scope: 'remote' as const, label: 'Server' } },
  { id: '2', title: 'README.md', url: 'Markdown preview', routeIndicator: { scope: 'local' as const, label: 'Local' } },
]

describe('SessionCloseDialog', () => {
  it('lists the open browser tabs, focuses Cancel and confirms on request', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<SessionCloseDialog open hostName="prod-web-01" tabs={tabs} onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByText(/prod-web-01 still has browser tabs/)).toBeInTheDocument()
    const list = screen.getByTestId('session-close-tabs')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('http://127.0.0.1:3000')).toBeInTheDocument()
    expect(screen.getByText(/2 browser tabs · 1 through server port forwarding/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Close Session' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
