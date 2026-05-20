import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import en from './locales/en'
import zhCN from './locales/zh-CN'

export type Locale = 'en' | 'zh-CN'
export const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
]

const LOCALE_KEY = 'shellbeam.locale'
const dictionaries: Record<Locale, Record<string, string>> = { en, 'zh-CN': zhCN }

function detectLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY)
  if (stored === 'en' || stored === 'zh-CN') return stored
  const lang = navigator.language
  if (lang.startsWith('zh')) return 'zh-CN'
  return 'en'
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
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem(LOCALE_KEY, l)
    setLocaleState(l)
  }, [])

  const tFn = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )

  const value = useMemo(() => ({ locale, setLocale, t: tFn }), [locale, setLocale, tFn])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT() {
  const context = useContext(I18nContext)
  if (context) return context

  const locale = detectLocale()
  return {
    locale,
    setLocale: (l: Locale) => {
      localStorage.setItem(LOCALE_KEY, l)
    },
    t: (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
  }
}
