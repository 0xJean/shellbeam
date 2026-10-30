import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SnippetCompactList } from './snippet-compact-list'
import type { SnippetEntry } from '@/lib/snippets'

const snippets: SnippetEntry[] = [
  { id: 'a', name: 'Disk usage', command: 'df -h', tags: [], createdAt: 1, updatedAt: 1 },
  { id: 'b', name: 'Port check', command: 'ss -tulpn | grep :{{port:8080}}', tags: [], createdAt: 2, updatedAt: 2 },
]

describe('SnippetCompactList', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('runs and applies commands without variables directly', () => {
    const onApply = vi.fn()
    const onRun = vi.fn()
    render(<SnippetCompactList snippets={snippets} onApply={onApply} onRun={onRun} />)
    fireEvent.click(screen.getAllByTitle('Run')[0])
    fireEvent.click(screen.getAllByTitle('Paste to Terminal')[0])
    expect(onRun).toHaveBeenCalledWith('df -h')
    expect(onApply).toHaveBeenCalledWith('df -h')
  })

  it('fills variables before running', () => {
    const onRun = vi.fn()
    render(<SnippetCompactList snippets={snippets} onApply={vi.fn()} onRun={onRun} />)
    fireEvent.click(screen.getAllByTitle('Run')[1])
    expect(onRun).not.toHaveBeenCalled()
    const form = screen.getByTestId('snippet-variable-fill')
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: '443' } })
    fireEvent.click(within(form).getByRole('button', { name: /Send/ }))
    expect(onRun).toHaveBeenCalledWith('ss -tulpn | grep :443')
  })

  it('filters by search', () => {
    render(<SnippetCompactList snippets={snippets} onApply={vi.fn()} onRun={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'disk' } })
    expect(screen.queryByText('Port check')).toBeNull()
    expect(screen.getByText('Disk usage')).toBeInTheDocument()
  })
})
