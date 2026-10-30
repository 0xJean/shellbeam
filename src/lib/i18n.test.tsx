import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, useT } from './i18n'

function Probe() {
  const { locale, preference, setLocale } = useT()
  return <div>
    <span data-testid="state">{preference}:{locale}</span>
    <button onClick={() => setLocale('en')}>en</button>
    <button onClick={() => setLocale('system')}>system</button>
  </div>
}

const state = () => screen.getByTestId('state').textContent

describe('locale preference', () => {
  beforeEach(() => localStorage.removeItem('shellbeam.locale'))
  afterEach(() => vi.restoreAllMocks())

  it('follows the system language by default and when it changes', () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-Hans-CN')
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(state()).toBe('system:zh-CN')
    language.mockReturnValue('en-US')
    act(() => { window.dispatchEvent(new Event('languagechange')) })
    expect(state()).toBe('system:en')
  })

  it('keeps a fixed language and can go back to following the system', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    render(<I18nProvider><Probe /></I18nProvider>)
    fireEvent.click(screen.getByText('en'))
    expect(state()).toBe('en:en')
    expect(localStorage.getItem('shellbeam.locale')).toBe('en')
    fireEvent.click(screen.getByText('system'))
    expect(state()).toBe('system:zh-CN')
    expect(localStorage.getItem('shellbeam.locale')).toBeNull()
  })
})
