import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

const STORAGE_KEY = 'shellbeam.theme'
const PREFERENCE_EVENT = 'shellbeam:theme-preference'
const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

function getSystemTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_QUERY).matches ? 'dark' : 'light'
}

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* Storage may be unavailable; follow the system. */ }
  return 'system'
}

function writePreference(preference: ThemePreference) {
  try { localStorage.setItem(STORAGE_KEY, preference) } catch { /* Preference stays for this session only. */ }
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: preference }))
}

/** Light, dark or follow the OS; the stored preference is shared by every caller. */
export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)
  useEffect(() => {
    const onChange = (event: Event) => setPreference((event as CustomEvent<ThemePreference>).detail)
    window.addEventListener(PREFERENCE_EVENT, onChange)
    return () => window.removeEventListener(PREFERENCE_EVENT, onChange)
  }, [])
  return [preference, writePreference] as const
}

export function useTheme() {
  const [preference, setPreference] = useThemePreference()
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme)
  const theme: Theme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(SYSTEM_QUERY)
    const onChange = () => setSystemTheme(query.matches ? 'dark' : 'light')
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [preference])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return {
    theme,
    preference,
    toggleTheme: () => setPreference(theme === 'dark' ? 'light' : 'dark'),
    setTheme: (next: ThemePreference) => setPreference(next),
  }
}
