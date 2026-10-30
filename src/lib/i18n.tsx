import { createContext, useContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import en from './locales/en'
import zhCN from './locales/zh-CN'

export type Locale = 'en' | 'zh-CN'
/** A fixed language, or 'system' to follow the OS language. */
export type LocalePreference = Locale | 'system'
export const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
]

const LOCALE_KEY = 'shellbeam.locale'
const dictionaries: Record<Locale, Record<string, string>> = { en, 'zh-CN': zhCN }

function systemLocale(): Locale {
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** Nothing stored means following the system. */
function readPreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_KEY)
    if (stored === 'en' || stored === 'zh-CN') return stored
  } catch { /* Storage may be unavailable; follow the system. */ }
  return 'system'
}

function writePreference(preference: LocalePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(LOCALE_KEY)
    else localStorage.setItem(LOCALE_KEY, preference)
  } catch { /* Preference stays for this session only. */ }
}

function detectLocale(): Locale {
  const preference = readPreference()
  return preference === 'system' ? systemLocale() : preference
}

function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let str = dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v))
    }
  }
  return str
}

/** Standalone t() for non-component code (reads locale from localStorage, non-reactive) */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = detectLocale()
  return translate(locale, key, params)
}

interface I18nContextValue {
  locale: Locale
  preference: LocalePreference
  setLocale: (l: LocalePreference) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LocalePreference>(readPreference)
  const [system, setSystem] = useState<Locale>(systemLocale)
  const locale = preference === 'system' ? system : preference

  useEffect(() => {
    const onChange = () => setSystem(systemLocale())
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [])

  const setLocale = useCallback((l: LocalePreference) => {
    writePreference(l)
    setPreference(l)
    setSystem(systemLocale())
  }, [])

  const tFn = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )

  const value = useMemo(() => ({ locale, preference, setLocale, t: tFn }), [locale, preference, setLocale, tFn])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT() {
  const context = useContext(I18nContext)
  if (context) return context

  const locale = detectLocale()
  return {
    locale,
    preference: readPreference(),
    setLocale: writePreference,
    t: (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
  }
}
