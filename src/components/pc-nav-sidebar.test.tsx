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

  it('offers the guide in mobile More and closes the menu after navigation', () => {
    const onNavChange = vi.fn()
    render(<MobileBottomNav activeNav="hosts" onNavChange={onNavChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'nav.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'guide.title' }))
    expect(onNavChange).toHaveBeenCalledWith('guide')
    expect(screen.queryByRole('button', { name: 'guide.title' })).not.toBeInTheDocument()
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
