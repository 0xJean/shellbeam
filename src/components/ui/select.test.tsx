import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSelect } from './select'
import { Dialog, DialogContent } from './dialog'

const options = <><option value="all">All states</option><option value="blocked" disabled>Unavailable</option><option value="online">Online</option><option value="offline">Offline</option></>
afterEach(() => vi.restoreAllMocks())

describe('application select menu', () => {
  it('chooses through the visible menu with a real field event and preserves controlled state', () => {
    const change = vi.fn()
    function Form() {
      const [value, setValue] = useState('all')
      return <label>Status<NativeSelect name="status" value={value} onChange={event => { change(event.target.tagName, event.target.value); setValue(event.target.value) }}>{options}</NativeSelect></label>
    }
    render(<Form />)
    const field = screen.getByRole('combobox', { name: 'Status' })
    fireEvent.click(field)
    const menu = screen.getByRole('listbox')
    fireEvent.click(within(menu).getByRole('option', { name: 'Unavailable' }))
    expect(change).not.toHaveBeenCalled()
    fireEvent.click(within(menu).getByRole('option', { name: 'Online' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('SELECT', 'online')
    expect(field).toHaveValue('online')
    expect(field).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('supports arrow keys, disabled options, Home/End, search and cancellation without premature writes', () => {
    const change = vi.fn()
    render(<NativeSelect aria-label="Status" value="all" onChange={change}>{options}</NativeSelect>)
    const field = screen.getByRole('combobox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(document.getElementById(field.getAttribute('aria-activedescendant')!)).toHaveTextContent('Online')
    expect(change).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'End' })
    expect(document.getElementById(field.getAttribute('aria-activedescendant')!)).toHaveTextContent('Offline')
    fireEvent.keyDown(field, { key: 'Home' })
    expect(document.getElementById(field.getAttribute('aria-activedescendant')!)).toHaveTextContent('All states')
    fireEvent.keyDown(field, { key: 'o' })
    fireEvent.keyDown(field, { key: 'n' })
    expect(document.getElementById(field.getAttribute('aria-activedescendant')!)).toHaveTextContent('Online')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(change).not.toHaveBeenCalled()
    expect(field).toHaveValue('all')
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('does not activate the host row on pointer or keyboard selection and resets action menus', () => {
    const rowClick = vi.fn(), rowKey = vi.fn(), change = vi.fn()
    render(<div onClick={rowClick} onKeyDown={rowKey}><NativeSelect aria-label="Operations" value="" onChange={change}><option value="">Operations</option><option value="logs">Logs</option></NativeSelect></div>)
    const field = screen.getByRole('combobox')
    for (let index = 0; index < 2; index++) {
      fireEvent.click(field)
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Logs' }))
      expect(field).toHaveValue('')
    }
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(change).toHaveBeenCalledTimes(2)
    expect(rowClick).not.toHaveBeenCalled()
    expect(rowKey).not.toHaveBeenCalled()
  })

  it('keeps a menu inside the modal top layer and clamps it to the viewport', () => {
    vi.spyOn(HTMLSelectElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 720, bottom: 756, left: 990, right: 1100, width: 110, height: 36, x: 990, y: 720, toJSON() {} })
    render(<Dialog open onOpenChange={vi.fn()}><DialogContent><NativeSelect aria-label="Host" value="all">{options}</NativeSelect></DialogContent></Dialog>)
    fireEvent.click(screen.getByRole('combobox'))
    const menu = screen.getByRole('listbox')
    expect(menu.closest('dialog')).toBe(screen.getByRole('dialog'))
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(menu.style.bottom).not.toBe('')
    expect(menu.style.top).toBe('')
  })

  it('closes on outside interaction and Tab; disabled controls never open', () => {
    const { rerender } = render(<NativeSelect aria-label="Status" value="all">{options}</NativeSelect>)
    const field = screen.getByRole('combobox')
    fireEvent.click(field)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(field)
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    rerender(<NativeSelect aria-label="Status" value="all" disabled>{options}</NativeSelect>)
    fireEvent.click(field)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it.each([-3000, 3000])('keeps a portal inside the window when its trigger moves to y=%s', y => {
    vi.spyOn(HTMLSelectElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: y, bottom: y + 36, left: 182, right: 427, width: 245, height: 36, x: 182, y, toJSON() {} })
    render(<NativeSelect aria-label="Moved field" value="all">{options}</NativeSelect>)
    fireEvent.click(screen.getByRole('combobox'))
    const menu = screen.getByRole('listbox')
    const maxHeight = Number.parseFloat(menu.style.maxHeight)
    const top = menu.style.top ? Number.parseFloat(menu.style.top) : window.innerHeight - Number.parseFloat(menu.style.bottom) - maxHeight
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight)
  })

  it('reveals a keyboard option by scrolling its menu without scrolling document ancestors', () => {
    render(<NativeSelect aria-label="Status" value="all">{options}</NativeSelect>)
    const field = screen.getByRole('combobox')
    fireEvent.click(field)
    const menu = screen.getByRole('listbox')
    const last = within(menu).getByRole('option', { name: 'Offline' })
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(last, 'offsetTop', { configurable: true, value: 140 })
    Object.defineProperty(last, 'offsetHeight', { configurable: true, value: 36 })
    const scrollAncestors = vi.fn()
    last.scrollIntoView = scrollAncestors
    fireEvent.keyDown(field, { key: 'End' })
    expect(menu.scrollTop).toBe(76)
    expect(scrollAncestors).not.toHaveBeenCalled()
    expect(field.getAttribute('aria-activedescendant')).toBe(last.id)
  })
})
