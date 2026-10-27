import { beforeEach, describe, expect, it } from 'vitest'
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, resolveAccent, resolveUiStyle, setAppearance } from './appearance'

describe('appearance preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    const root = document.documentElement
    delete root.dataset.darkPalette
    delete root.dataset.lightPalette
    delete root.dataset.darkAccent
    delete root.dataset.lightAccent
    delete root.dataset.darkStyle
    delete root.dataset.lightStyle
  })

  it('defaults to Midnight / Aqua with palette accents', () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    applyAppearance(DEFAULT_APPEARANCE)
    expect(document.documentElement.dataset).toMatchObject({ darkPalette: 'midnight', lightPalette: 'aqua', darkAccent: 'violet', lightAccent: 'blue', darkStyle: 'outline', lightStyle: 'elevated' })
  })

  it('rejects palettes from the wrong family and unknown accents', () => {
    localStorage.setItem('shellbeam.appearance', JSON.stringify({ darkPalette: 'paper', lightPalette: 'nord', darkAccent: 'neon', lightAccent: 'teal' }))
    expect(loadAppearance()).toEqual({ darkPalette: 'midnight', lightPalette: 'aqua', darkAccent: null, lightAccent: 'teal', uiStyle: 'auto' })
  })

  it('falls back to defaults when storage holds invalid JSON', () => {
    localStorage.setItem('shellbeam.appearance', '{oops')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
  })

  it('follows the palette accent until an accent is chosen', () => {
    const prefs = { ...DEFAULT_APPEARANCE, darkPalette: 'nord' as const }
    expect(resolveAccent(prefs, 'dark')).toBe('cyan')
    expect(resolveAccent({ ...prefs, darkAccent: 'amber' }, 'dark')).toBe('amber')
  })

  it('persists and applies updates', () => {
    setAppearance({ lightPalette: 'solarized', darkAccent: 'pink' })
    expect(JSON.parse(localStorage.getItem('shellbeam.appearance')!)).toMatchObject({ lightPalette: 'solarized', darkAccent: 'pink' })
    expect(document.documentElement.dataset).toMatchObject({ lightPalette: 'solarized', lightAccent: 'teal', darkAccent: 'pink' })
  })

  it('pairs outline with dark and elevated with light until a style is chosen', () => {
    expect(resolveUiStyle(DEFAULT_APPEARANCE, 'dark')).toBe('outline')
    expect(resolveUiStyle(DEFAULT_APPEARANCE, 'light')).toBe('elevated')
    setAppearance({ uiStyle: 'sharp' })
    expect(document.documentElement.dataset).toMatchObject({ darkStyle: 'sharp', lightStyle: 'sharp' })
    localStorage.setItem('shellbeam.appearance', JSON.stringify({ uiStyle: 'neon' }))
    expect(loadAppearance().uiStyle).toBe('auto')
  })
})
