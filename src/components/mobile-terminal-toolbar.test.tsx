import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalToolbar } from './mobile-terminal-toolbar'

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })
afterEach(cleanup)

const press = (name: string) => fireEvent.mouseDown(screen.getByRole('button', { name }))

describe('MobileTerminalToolbar', () => {
  it('sends the persistent keys through onSend', () => {
    const onSend = vi.fn()
    render(<MobileTerminalToolbar onSend={onSend} />)
    press('esc'); press('tab'); press('↑'); press('←'); press('|')
    expect(onSend.mock.calls.map(([data]) => data)).toEqual(['\x1b', '\t', '\x1b[A', '\x1b[D', '|'])
  })

  it('arms ctrl for the next key only and locks it on double tap', () => {
    const onSend = vi.fn()
    render(<MobileTerminalToolbar onSend={onSend} />)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const ctrl = screen.getByRole('button', { name: 'ctrl' })
    fireEvent.mouseDown(ctrl)
    expect(ctrl).toHaveAttribute('data-state', 'once')
    press('~')
    expect(onSend).toHaveBeenLastCalledWith('~')
    expect(ctrl).toHaveAttribute('data-state', 'off')
    now.mockReturnValue(5_000); fireEvent.mouseDown(ctrl)
    now.mockReturnValue(5_200); fireEvent.mouseDown(ctrl)
    expect(ctrl).toHaveAttribute('data-state', 'locked')
    press('↑')
    expect(ctrl).toHaveAttribute('data-state', 'locked')
    now.mockRestore()
  })

  it('opens the key panel with tabs, legend and ctrl shortcuts', () => {
    const onSend = vi.fn()
    render(<MobileTerminalToolbar onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'Function keys' }))
    expect(screen.getByRole('tab', { name: 'Function keys' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.mouseDown(screen.getByRole('button', { name: 'F5' }))
    expect(onSend).toHaveBeenLastCalledWith('\x1b[15~')
    fireEvent.click(screen.getByRole('tab', { name: 'Ctrl shortcuts' }))
    fireEvent.mouseDown(screen.getByText('^C').closest('button')!)
    expect(onSend).toHaveBeenLastCalledWith('\x03')
    expect(screen.getByText('Interrupt')).toBeInTheDocument()
    expect(screen.getByText(/Double-tap: lock/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close key panel' }))
    expect(screen.queryByTestId('mobile-key-panel')).not.toBeInTheDocument()
  })
})
