import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppearancePicker } from './appearance-picker'
import { setAppearance, DEFAULT_APPEARANCE } from '@/lib/appearance'

describe('AppearancePicker', () => {
  beforeEach(() => {
    localStorage.clear()
    setAppearance(DEFAULT_APPEARANCE)
  })

  it('switches the palette of each family independently', () => {
    render(<AppearancePicker family="dark" />)
    fireEvent.click(screen.getByTestId('palette-dracula'))
    fireEvent.click(screen.getByTestId('palette-mist'))
    expect(screen.getByTestId('palette-dracula')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('palette-mist')).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset).toMatchObject({ darkPalette: 'dracula', darkAccent: 'pink', lightPalette: 'mist', lightAccent: 'green' })
  })

  it('overrides the accent of the active family only', () => {
    render(<AppearancePicker family="light" />)
    fireEvent.click(screen.getByTestId('accent-amber'))
    expect(screen.getByTestId('accent-amber')).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset).toMatchObject({ lightAccent: 'amber', darkAccent: 'violet' })
  })
})
