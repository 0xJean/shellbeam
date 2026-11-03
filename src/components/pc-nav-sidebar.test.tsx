import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBarLayout } from '@/lib/bar-layout'
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
  describe('where iOS asks for a vertical bar', () => {
    afterEach(() => act(() => applyBarLayout({ verticalBarEdge: 'none', horizontalSizeClass: 'unspecified' })))

    it('stands the tabs up on that edge with icons only', () => {
      const onNavChange = vi.fn()
      render(<MobileBottomNav activeNav="hosts" onNavChange={onNavChange} />)
      act(() => applyBarLayout({ verticalBarEdge: 'trailing', horizontalSizeClass: 'compact' }))
      const nav = screen.getByTestId('mobile-bottom-nav')
      expect(nav).toHaveAttribute('data-axis', 'vertical')
      expect(nav).toHaveClass('right-0')
      expect(document.documentElement.dataset.verticalBarEdge).toBe('trailing')
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['', '', '', '', ''])
      fireEvent.click(screen.getByRole('button', { name: 'nav.files' }))
      expect(onNavChange).toHaveBeenCalledWith('sftp')
      expect(screen.getByRole('button', { name: 'nav.hosts' })).toHaveAttribute('aria-current', 'page')

      act(() => applyBarLayout({ verticalBarEdge: 'leading', horizontalSizeClass: 'compact' }))
      expect(screen.getByTestId('mobile-bottom-nav')).toHaveClass('left-0')

      act(() => applyBarLayout({ verticalBarEdge: 'none', horizontalSizeClass: 'regular' }))
      expect(screen.getByTestId('mobile-bottom-nav')).not.toHaveAttribute('data-axis')
      expect(document.documentElement.dataset.verticalBarEdge).toBeUndefined()
    })
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
