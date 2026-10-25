import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpHostPicker, type McpHostSelection } from './mcp-host-picker'
import type { HostProfile } from '@/lib/hosts'

function host(id: string, extra: Partial<HostProfile> = {}): HostProfile {
  return { id, name: id, address: `192.0.2.${id.length}`, username: 'ops', port: 22, authType: 'password', group: 'Development', tags: [], createdAt: 1, updatedAt: 1, ...extra }
}
function Picker({ hosts }: { hosts: HostProfile[] }) {
  const [selection, setSelection] = useState<McpHostSelection>({ hostIds: [], connectionIds: {} })
  return <><McpHostPicker hosts={hosts} selection={selection} onChange={setSelection} disabled={false} loading={false} /><output data-testid="selection">{JSON.stringify(selection)}</output></>
}
const current = () => JSON.parse(screen.getByTestId('selection').textContent!) as McpHostSelection
beforeEach(() => localStorage.setItem('shellbeam.locale', 'en'))
afterEach(cleanup)

describe('MCP host selection', () => {
  it('selects only filtered results and keeps hidden selections until explicitly removed', () => {
    render(<Picker hosts={[host('API', { group: 'Production', tags: ['payments'] }), host('Database', { group: 'Production' }), host('Development')]} />)
    fireEvent.click(screen.getByLabelText('Development'))
    fireEvent.change(screen.getByLabelText('Host group'), { target: { value: 'Production' } })
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: 'payments' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(current()).toEqual({ hostIds: ['Development', 'API'], connectionIds: { Development: ['Development'], API: ['API'] } })
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Host group'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Selected only' }))
    expect(screen.queryByLabelText('Database')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('API'))
    expect(current()).toEqual({ hostIds: ['Development'], connectionIds: { Development: ['Development'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(current()).toEqual({ hostIds: [], connectionIds: {} })
  })

  it('shows unchecked, mixed and checked states and removes only filtered hosts and their accounts', () => {
    render(<Picker hosts={[host('API', { group: 'Production' }), host('Database', { group: 'Production' }), host('Dev')]} />)
    const all = screen.getByRole('checkbox', { name: 'Select all' })
    expect(all).not.toBeChecked()
    expect(all).not.toBePartiallyChecked()
    fireEvent.click(screen.getByLabelText('Dev'))
    fireEvent.click(screen.getByLabelText('API'))
    expect(all).toBePartiallyChecked()
    expect(all).toHaveAttribute('aria-checked', 'mixed')
    expect(screen.getByText('Selected 2/100')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Host group'), { target: { value: 'Production' } })
    // Changing a chosen account to cache-only must survive bulk addition of another host.
    fireEvent.click(screen.getByLabelText(/API · .*ops@/))
    fireEvent.click(all)
    expect(all).toBeChecked()
    expect(all).not.toBePartiallyChecked()
    expect(current().connectionIds.API).toEqual([])
    expect(screen.getByText('Selected 3/100')).toBeVisible()
    fireEvent.click(all)
    expect(current()).toEqual({ hostIds: ['Dev'], connectionIds: { Dev: ['Dev'] } })
    expect(all).not.toBeChecked()
    expect(all).not.toBePartiallyChecked()
    fireEvent.change(screen.getByLabelText('Host group'), { target: { value: '' } })
    expect(all).toBePartiallyChecked()
    fireEvent.click(all)
    expect(current().hostIds).toHaveLength(3)
    fireEvent.click(all)
    expect(current()).toEqual({ hostIds: [], connectionIds: {} })
  })

  it('does not change hidden selections for empty results or selected-only bulk deselection', () => {
    render(<Picker hosts={[host('API'), host('Database')]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: 'absent' } })
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Select all' })).not.toBeChecked()
    expect(screen.getByText('Selected 2/100')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Selected only' }))
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: 'API' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(current()).toEqual({ hostIds: ['Database'], connectionIds: { Database: ['Database'] } })
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(current()).toEqual({ hostIds: [], connectionIds: {} })
  })

  it('requires explicit selection of a sole non-default account and never grants a missing default', () => {
    render(<Picker hosts={[host('No default', { defaultConnectionId: null, connections: [{ id: 'other', label: 'Support', username: 'support', address: '192.0.2.70', port: 2222, authType: 'password' }] })]} />)
    fireEvent.click(screen.getByLabelText('No default'))
    expect(current().connectionIds['No default']).toEqual([])
    fireEvent.click(screen.getByLabelText('No default · Support · support@192.0.2.70:2222'))
    expect(current().connectionIds['No default']).toEqual(['other'])
  })

  it('shows monitoring-only hosts without inventing an SSH address or account', () => {
    render(<Picker hosts={[host('Metrics node', { connections: [], address: '', username: '', port: 0 })]} />)
    fireEvent.click(screen.getByLabelText('Metrics node'))
    expect(current()).toEqual({ hostIds: ['Metrics node'], connectionIds: { 'Metrics node': [] } })
    expect(screen.getByText('Monitoring only · no SSH')).toBeVisible()
    expect(screen.queryByText('@:0')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('mcp-host-options')).getAllByRole('checkbox')).toHaveLength(1)
  })

  it('does not silently select the first hundred matches when the result exceeds the limit', () => {
    render(<Picker hosts={Array.from({ length: 101 }, (_, index) => host(`Host ${index}`, { tags: index < 100 ? ['subset'] : [] }))} />)
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeDisabled()
    expect(current().hostIds).toEqual([])
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: 'subset' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(current().hostIds).toHaveLength(100)
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeChecked()
    fireEvent.change(screen.getByLabelText('Search hosts, addresses, accounts or tags'), { target: { value: '' } })
    expect(screen.getByLabelText('Host 100')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Host 0'))
    expect(screen.getByLabelText('Host 100')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Host 100'))
    expect(current().hostIds).toHaveLength(100)
    expect(current().connectionIds['Host 0']).toBeUndefined()
  })
})
