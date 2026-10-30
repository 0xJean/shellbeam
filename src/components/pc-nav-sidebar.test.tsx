import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileBottomNav, PcNavSidebar } from './pc-nav-sidebar'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))

describe('pc nav sidebar', () => {
  it('offers a persistent guide entry on desktop', () => {
    const onNavChange = vi.fn()
    render(<PcNavSidebar activeNav="hosts" onNavChange={onNavChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'guide.title' }))
    expect(onNavChange).toHaveBeenCalledWith('guide')
  })

  it('uses five fixed mobile tabs and keeps Tools active on pages opened from it', () => {
    const onNavChange = vi.fn()
    const { rerender } = render(<MobileBottomNav activeNav="hosts" onNavChange={onNavChange} />)
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['nav.hosts', 'nav.sessions', 'nav.files', 'nav.tools', 'nav.settings'])
    expect(screen.queryByRole('button', { name: 'nav.more' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'nav.tools' }))
    expect(onNavChange).toHaveBeenCalledWith('tools')
    rerender(<MobileBottomNav activeNav="port-forwarding" onNavChange={onNavChange} />)
    expect(screen.getByRole('button', { name: 'nav.tools' })).toHaveAttribute('aria-current', 'page')
  })
  it('shows the VPS asset inventory top-level entry', () => {
    const onNavChange = vi.fn()
    render(<PcNavSidebar activeNav="hosts" onNavChange={onNavChange} />)

    fireEvent.click(screen.getByRole('button', { name: /nav\.assetInventory/i }))

    expect(onNavChange).toHaveBeenCalledWith('asset-inventory')
  })

  it('keeps project deployments out of the top-level sidebar', () => {
    render(<PcNavSidebar activeNav="hosts" onNavChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /nav\.projectDeployments/i })).not.toBeInTheDocument()
  })
})
