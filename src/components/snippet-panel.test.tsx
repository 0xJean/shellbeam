import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SnippetPanel } from './snippet-panel'
import type { SnippetEntry } from '@/lib/snippets'

const snippets: SnippetEntry[] = [
  { id: 's1', name: 'Reload nginx', command: 'sudo nginx -t && sudo systemctl reload nginx', tags: ['nginx'], createdAt: 1, updatedAt: 1, lastUsedAt: 50 },
  { id: 's2', name: 'Port check', command: 'sudo ss -tulpn | grep :{{port:8080}}', tags: ['system'], createdAt: 2, updatedAt: 2 },
  { id: 's3', name: 'Backup db', command: 'pg_dump {{db}} > /backup/{{db}}.sql', tags: [], createdAt: 3, updatedAt: 3, lastUsedAt: 90 },
]

const props = (patch = {}) => ({
  snippets, selectedSnippetId: null, saving: false, running: false,
  onSelectSnippet: vi.fn(), onCreateSnippet: vi.fn(async () => {}), onUpdateSnippet: vi.fn(async () => {}),
  onDeleteSnippet: vi.fn(async () => {}), onApplySnippetCommand: vi.fn(), onRunSnippet: vi.fn(async () => {}), ...patch,
})

const cardNames = () => screen.getAllByTestId('snippet-card').map((card) => card.querySelector('button')?.textContent)

describe('SnippetPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('derives categories from tags and filters by them', () => {
    render(<SnippetPanel {...props()} />)
    const nav = screen.getByTestId('snippet-categories')
    expect(within(nav).getByRole('button', { name: /All\s*3/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(nav).getByRole('button', { name: /nginx/ }))
    expect(cardNames()).toEqual(['Reload nginx'])
    fireEvent.click(within(nav).getByRole('button', { name: /Untagged/ }))
    expect(cardNames()).toEqual(['Backup db'])
    fireEvent.click(within(nav).getByRole('button', { name: /Recently used\s*2/ }))
    expect(cardNames()).toEqual(['Backup db', 'Reload nginx'])
  })

  it('sorts by name', () => {
    render(<SnippetPanel {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(cardNames()).toEqual(['Backup db', 'Port check', 'Reload nginx'])
  })

  it('highlights variables in the command preview', () => {
    const { container } = render(<SnippetPanel {...props()} />)
    expect(Array.from(container.querySelectorAll('[data-snippet-variable]')).map((el) => el.textContent)).toEqual(['{{db}}', '{{db}}', '{{port:8080}}'])
  })

  it('applies a command without variables directly', () => {
    const input = props()
    render(<SnippetPanel {...input} />)
    const card = screen.getAllByTestId('snippet-card').find((el) => el.textContent?.includes('Reload nginx'))!
    fireEvent.click(within(card).getByRole('button', { name: /Run…/ }))
    expect(input.onApplySnippetCommand).toHaveBeenCalledWith('sudo nginx -t && sudo systemctl reload nginx')
  })

  it('asks for variable values before applying', () => {
    const input = props()
    render(<SnippetPanel {...input} />)
    const card = screen.getAllByTestId('snippet-card').find((el) => el.textContent?.includes('Backup db'))!
    fireEvent.click(within(card).getByRole('button', { name: /Run…/ }))
    expect(input.onApplySnippetCommand).not.toHaveBeenCalled()
    const form = screen.getByTestId('snippet-variable-fill')
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'app' } })
    expect(screen.getByTestId('snippet-variable-preview')).toHaveTextContent('pg_dump app > /backup/app.sql')
    fireEvent.click(within(form).getByRole('button', { name: /Send/ }))
    expect(input.onApplySnippetCommand).toHaveBeenCalledWith('pg_dump app > /backup/app.sql')
    expect(screen.queryByTestId('snippet-variable-fill')).toBeNull()
  })

  it('prefills defaults in the fill form', () => {
    const input = props()
    render(<SnippetPanel {...input} />)
    const card = screen.getAllByTestId('snippet-card').find((el) => el.textContent?.includes('Port check'))!
    fireEvent.click(within(card).getByRole('button', { name: /Run…/ }))
    fireEvent.click(within(screen.getByTestId('snippet-variable-fill')).getByRole('button', { name: /Send/ }))
    expect(input.onApplySnippetCommand).toHaveBeenCalledWith('sudo ss -tulpn | grep :8080')
  })

  it('creates a snippet with tag chips', () => {
    const input = props()
    render(<SnippetPanel {...input} />)
    fireEvent.click(screen.getByRole('button', { name: /New Snippet/i }))
    fireEvent.change(screen.getByPlaceholderText(/Deploy to production/i), { target: { value: 'Tail log' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'tail -f {{file}}' } })
    expect(screen.getAllByTestId('snippet-detected-variable').map((el) => el.textContent)).toEqual(['file'])
    const tagsInput = screen.getByLabelText('Tags')
    fireEvent.change(tagsInput, { target: { value: 'logs,' } })
    fireEvent.change(tagsInput, { target: { value: 'ops' } })
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }))
    expect(input.onCreateSnippet).toHaveBeenCalledWith({ name: 'Tail log', command: 'tail -f {{file}}', tags: ['logs', 'ops'] })
  })

  it('edits and deletes from the edit dialog', () => {
    const input = props()
    render(<SnippetPanel {...input} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload nginx' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag nginx' }))
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))
    expect(input.onUpdateSnippet).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', tags: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Port check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: /Delete this snippet/ }))
    expect(input.onDeleteSnippet).toHaveBeenCalledWith('s2')
  })
})
