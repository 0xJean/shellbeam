import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { requestSettingsCategory } from '@/lib/settings-request'
import { MobileSettingsPage } from './mobile-settings-page'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('@/components/settings-panel', () => ({
  SettingsPanel: ({ category, hideNavigation }: { category?: string; hideNavigation?: boolean }) =>
    <div data-testid="settings-panel-stub" data-category={category} data-hide-nav={String(!!hideNavigation)} />,
}))
vi.mock('@/contexts/vault-context', () => ({
  useVault: () => ({ vaults: [{ id: 'v1', name: '个人保管库' }], activeVaultId: 'v1', vaultStatusState: { initialized: true, unlocked: true, secretCount: 5 } }),
}))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: Array.from({ length: 9 }, (_, i) => ({ id: `h${i}` })) }) }))

const props = () => ({
  vaultAutoLockMinutes: 5,
  reconnectSettings: { enabled: true, maxRetries: 3, intervalMs: 1500 },
  defaultUsername: 'ops', keepAliveIntervalSecs: 30, theme: 'dark', onToggleTheme: vi.fn(),
  terminalPrefs: { fontSize: 12, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", themeId: 'default', cursorStyle: 'block' as const, cursorBlink: true },
  onTerminalPrefsChange: vi.fn(), onVaultAutoLockMinutesChange: vi.fn(),
  onReconnectSettingsChange: vi.fn(), onDefaultUsernameChange: vi.fn(), onKeepAliveIntervalSecsChange: vi.fn(),
})

afterEach(() => { cleanup(); localStorage.clear() })

describe('MobileSettingsPage', () => {
  it('lists real setting values and opens the matching settings category', () => {
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    render(<I18nProvider><MobileSettingsPage {...props()} /></I18nProvider>)
    expect(screen.getByTestId('mobile-settings-vault')).toHaveTextContent('个人保管库')
    expect(screen.getByTestId('mobile-settings-vault')).toHaveTextContent('已解锁 · 9 台主机 · 5 项机密')
    expect(screen.getByTestId('mobile-settings-row-font')).toHaveTextContent('JetBrains Mono')
    expect(screen.getByTestId('mobile-settings-row-font-size')).toHaveTextContent('12')
    expect(screen.getByTestId('mobile-settings-row-auto-lock')).toHaveTextContent('5 分钟')
    expect(screen.queryByTestId('settings-panel-stub')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mobile-settings-row-font'))
    expect(screen.getByTestId('settings-panel-stub')).toHaveAttribute('data-category', 'connection')
    expect(screen.getByTestId('settings-panel-stub')).toHaveAttribute('data-hide-nav', 'true')
    fireEvent.click(screen.getByTestId('mobile-settings-back'))
    expect(screen.getByTestId('mobile-settings-page')).toBeInTheDocument()
  })

  it('follows category requests from other screens', () => {
    render(<I18nProvider><MobileSettingsPage {...props()} /></I18nProvider>)
    act(() => requestSettingsCategory('monitoring'))
    expect(screen.getByTestId('settings-panel-stub')).toHaveAttribute('data-category', 'monitoring')
  })
})
