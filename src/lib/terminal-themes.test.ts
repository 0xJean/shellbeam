import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, setAppearance } from './appearance'
import { APP_TERMINAL_THEME_ID, appTerminalTheme, loadTerminalPrefs, saveTerminalPrefs, TERMINAL_THEMES, useResolvedTerminalTheme, useTerminalThemes } from './terminal-themes'

afterEach(() => { localStorage.clear(); document.documentElement.classList.remove('dark'); setAppearance(DEFAULT_APPEARANCE) })

describe('terminal themes', () => {
  it('follows the app theme by default', () => {
    expect(loadTerminalPrefs().themeId).toBe(APP_TERMINAL_THEME_ID)
  })

  it('moves the old saved default over to following the app, and keeps real choices', () => {
    localStorage.setItem('shellbeam.terminalPrefs', JSON.stringify({ themeId: 'hacker-green', fontSize: 16 }))
    expect(loadTerminalPrefs()).toMatchObject({ themeId: APP_TERMINAL_THEME_ID, fontSize: 16 })
    localStorage.setItem('shellbeam.terminalPrefs', JSON.stringify({ themeId: 'dracula' }))
    expect(loadTerminalPrefs().themeId).toBe('dracula')
    saveTerminalPrefs({ ...loadTerminalPrefs(), themeId: 'hacker-green' })
    expect(loadTerminalPrefs().themeId).toBe('hacker-green')
    expect(loadTerminalPrefs()).not.toHaveProperty('version')
  })

  it('builds the follow-app theme with each palette’s own canvas, cursor, and harmonized ANSI colours', () => {
    const obsidian = appTerminalTheme('dark', DEFAULT_APPEARANCE)
    const tokyo = appTerminalTheme('dark', { ...DEFAULT_APPEARANCE, darkPalette: 'tokyo-night' })
    const graphiteLight = appTerminalTheme('light', { ...DEFAULT_APPEARANCE, lightPalette: 'graphite-light' })

    expect(obsidian).toMatchObject({ background: '#10131b', cursor: '#5e8bff' })
    expect(tokyo).toMatchObject({ background: '#1a1b26', cursor: '#7aa2f7', green: '#9ece6a', blue: '#7aa2f7' })
    expect(tokyo.green).not.toBe(obsidian.green)
    expect(graphiteLight).toMatchObject({ background: '#f6f2ea', cursor: '#b45309' })
  })

  it('switches with the app light/dark mode and palette, but not for a fixed theme', async () => {
    const follow = renderHook(() => useResolvedTerminalTheme(APP_TERMINAL_THEME_ID))
    const fixed = renderHook(() => useResolvedTerminalTheme('dracula'))
    expect(follow.result.current.background).toBe('#f7f8fb')
    const draculaBg = fixed.result.current.background
    await act(async () => { document.documentElement.classList.add('dark') })
    expect(follow.result.current.background).toBe('#10131b')
    act(() => setAppearance({ darkPalette: 'nord' }))
    expect(follow.result.current.background).toBe('#222733')
    expect(fixed.result.current.background).toBe(draculaBg)
  })

  it('lists Follow theme first', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const { result } = renderHook(() => useTerminalThemes())
    expect(result.current[0]).toMatchObject({ id: APP_TERMINAL_THEME_ID, name: 'Follow theme' })
    expect(result.current).toHaveLength(TERMINAL_THEMES.length + 1)
  })
})
