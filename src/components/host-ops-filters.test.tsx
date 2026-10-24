import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostOpsAdvancedFilters } from './host-ops-filters'
import { DEFAULT_HOST_OPS_FILTERS } from '@/lib/host-ops-filters'
import { I18nProvider } from '@/lib/i18n'
describe('host operations advanced filters', () => {
  it('exposes each filter dimension and resets them together', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const onChange = vi.fn()
    render(<I18nProvider><HostOpsAdvancedFilters value={{ ...DEFAULT_HOST_OPS_FILTERS, provider: 'komari' }} onChange={onChange} osOptions={['Ubuntu']} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Capability'), { target: { value: 'docker' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'komari', capability: 'docker' }))
    expect(screen.getByLabelText('Probe provider')).toHaveValue('komari')
    expect(screen.getByLabelText('Probe provider')).toHaveTextContent('Monitoring service')
    expect(screen.getByLabelText('Operating system')).toBeInTheDocument()
    expect(screen.getByLabelText('Highest open alert severity')).toBeInTheDocument()
    expect(screen.getByLabelText('Resource threshold')).toBeInTheDocument()
    expect(screen.getByLabelText('Data freshness')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear operations filters' }))
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_HOST_OPS_FILTERS)
  })
})
