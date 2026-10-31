import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, setAppearance } from './appearance'
import { APP_TERMINAL_THEME_ID, appTerminalTheme, loadTerminalPrefs, saveTerminalPrefs, useResolvedTerminalTheme, useTerminalThemes } from './terminal-themes'

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

  it('builds the follow-app theme from the palette and accent', () => {
    expect(appTerminalTheme('dark', DEFAULT_APPEARANCE)).toMatchObject({ background: '#000000', cursor: '#0a84ff' })
    expect(appTerminalTheme('light', { ...DEFAULT_APPEARANCE, lightPalette: 'paper' })).toMatchObject({ background: '#fffdf8', cursor: '#c25200' })
  })

  it('switches with the app light/dark mode and palette, but not for a fixed theme', async () => {
    const follow = renderHook(() => useResolvedTerminalTheme(APP_TERMINAL_THEME_ID))
    const fixed = renderHook(() => useResolvedTerminalTheme('dracula'))
    expect(follow.result.current.background).toBe('#ffffff')
    const draculaBg = fixed.result.current.background
    await act(async () => { document.documentElement.classList.add('dark') })
    expect(follow.result.current.background).toBe('#000000')
    act(() => setAppearance({ darkPalette: 'nord' }))
    expect(follow.result.current.background).toBe('#1e222a')
    expect(fixed.result.current.background).toBe(draculaBg)
  })

  it('lists Follow theme first', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const { result } = renderHook(() => useTerminalThemes())
    expect(result.current[0]).toMatchObject({ id: APP_TERMINAL_THEME_ID, name: 'Follow theme' })
    expect(result.current).toHaveLength(8)
  })
})
