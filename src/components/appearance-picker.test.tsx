import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppearancePicker } from './appearance-picker'
import { DEFAULT_APPEARANCE, PALETTES, setAppearance, THEMES } from '@/lib/appearance'
import en from '@/lib/locales/en'

describe('AppearancePicker', () => {
  beforeEach(() => {
    localStorage.clear()
    setAppearance(DEFAULT_APPEARANCE)
  })

  it('sets both sides of a theme, so the mode picks the side', () => {
    render(<AppearancePicker family="dark" />)
    expect(screen.getByTestId('theme-aqua')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByTestId('theme-dracula'))
    expect(screen.getByTestId('theme-dracula')).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset).toMatchObject({ darkPalette: 'dracula', darkAccent: 'pink', lightPalette: 'dracula-light', lightAccent: 'pink' })
  })

  it('offers eight themes that each have both sides', () => {
    expect(THEMES).toHaveLength(8)
    for (const theme of THEMES) {
      expect(PALETTES[theme.dark].family).toBe('dark')
      expect(PALETTES[theme.light].family).toBe('light')
    }
  })

  it('applies a custom accent to both sides and can go back to the theme colour', () => {
    render(<AppearancePicker family="light" />)
    fireEvent.click(screen.getByTestId('accent-amber'))
    expect(screen.getByTestId('accent-amber')).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset).toMatchObject({ lightAccent: 'amber', darkAccent: 'amber' })
    fireEvent.click(screen.getByRole('button', { name: en['settings.accentFollowPalette'] }))
    expect(document.documentElement.dataset).toMatchObject({ lightAccent: 'blue', darkAccent: 'blue' })
  })
})
