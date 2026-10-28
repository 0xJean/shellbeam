import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import { settingsV3Copy } from '@/lib/locales/settings-v3'
import { fill } from '@/lib/locales/probe-install'
import { consumeSettingsCategoryRequest, requestSettingsCategory } from '@/lib/settings-request'
import { SettingsPanel } from './settings-panel'

vi.mock('@/components/terminal-widgets', () => ({ TerminalThemeGrid: () => <div>Terminal themes</div> }))
vi.mock('@/components/ai-model-picker', () => ({ AIModelPicker: () => <div>AI models</div> }))
vi.mock('@/components/mcp-settings-section', () => ({ McpSettingsSection: () => <div data-testid="mcp-settings">MCP</div> }))
vi.mock('@/components/komari-settings-section', () => ({ KomariSettingsSection: () => <div data-testid="komari-settings">Komari</div> }))
vi.mock('@/components/shellbeam-agent-release-settings-section', () => ({ ShellbeamAgentReleaseSettingsSection: () => <div data-testid="agent-settings">Agent releases</div> }))
vi.mock('@/components/notification-settings-section', () => ({ NotificationSettingsSection: () => <div data-testid="notification-settings">Notifications</div> }))
vi.mock('@/components/probe-retry-settings-section', () => ({ ProbeRetrySettingsSection: () => <div data-testid="probe-retry-settings">Recovery</div> }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ sessionPassword: '' }) }))
vi.mock('@/lib/biometric', () => ({ isBiometricEnabled: () => false, checkBiometricStatus: async () => ({ available: false }) }))

const props = () => ({
  onOpenGuide: vi.fn(), vaultAutoLockMinutes: 10,
  reconnectSettings: { enabled: true, maxRetries: 3, intervalMs: 1500 },
  defaultUsername: 'ops', keepAliveIntervalSecs: 30, theme: 'dark', onToggleTheme: vi.fn(),
  terminalPrefs: { fontSize: 14, fontFamily: 'Menlo', themeId: 'default', cursorStyle: 'block' as const, cursorBlink: true },
  onTerminalPrefsChange: vi.fn(), onVaultAutoLockMinutesChange: vi.fn(),
  onReconnectSettingsChange: vi.fn(), onDefaultUsernameChange: vi.fn(), onKeepAliveIntervalSecsChange: vi.fn(),
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('settings categories', () => {
  it.each(['en', 'zh-CN'] as const)('starts with everyday settings and exposes optional services only in their category (%s)', async (locale) => {
    localStorage.setItem('shellbeam.locale', locale)
    const copy = settingsNavigationCopy[locale]
    const text = locale === 'en' ? en : zhCN
    const input = props()
    render(<I18nProvider><SettingsPanel {...input} /></I18nProvider>)
    const nav = screen.getByRole('navigation', { name: copy.navigation })
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual([
      copy.general, copy.connection, copy.monitoring, copy.integrations, copy.security, copy.advanced,
    ])
    expect(within(nav).getByRole('button', { name: copy.general })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: copy.general })).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.language'] })).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.appearance'] })).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.vault'] })).toBeVisible()
    expect(screen.queryByTestId('komari-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-settings')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: text['settings.dangerZone'] })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: text['guide.open'] }))
    expect(input.onOpenGuide).toHaveBeenCalledOnce()

    fireEvent.click(within(nav).getByRole('button', { name: copy.connection }))
    expect(screen.getByRole('heading', { name: text['settings.terminal'] })).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.reconnect'] })).toBeVisible()
    fireEvent.change(screen.getByDisplayValue('ops'), { target: { value: 'deploy' } })
    expect(input.onDefaultUsernameChange).toHaveBeenCalledWith('deploy')
    fireEvent.click(screen.getByRole('button', { name: fill(settingsV3Copy[locale].increase, { label: text['settings.keepAlive'] }) }))
    expect(input.onKeepAliveIntervalSecsChange).toHaveBeenCalledWith(31)
    fireEvent.click(screen.getByRole('switch', { name: text['settings.autoReconnect'] }))
    expect(input.onReconnectSettingsChange).toHaveBeenCalledWith({ enabled: false })

    fireEvent.click(screen.getByTestId('settings-category-monitoring'))
    expect(screen.getByTestId('komari-settings')).toBeVisible()
    fireEvent.click(screen.getByTestId('monitor-tab-local'))
    expect(screen.getByTestId('notification-settings')).toBeVisible()
    fireEvent.click(within(nav).getByRole('button', { name: copy.integrations }))
    expect(screen.queryByTestId('komari-settings')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: text['settings.ai'] })).toBeVisible()
    fireEvent.click(within(nav).getByRole('button', { name: copy.advanced }))
    for (const id of ['mcp-settings', 'agent-settings', 'probe-retry-settings']) expect(screen.getByTestId(id)).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.dangerZone'] })).toBeVisible()
    expect(screen.queryByTestId('komari-settings')).not.toBeInTheDocument()
  })

  it('opens a category chosen by the mobile settings list without its own navigation', () => {
    localStorage.setItem('shellbeam.locale', 'en')
    requestSettingsCategory('monitoring')
    render(<I18nProvider><SettingsPanel {...props()} category="connection" hideNavigation /></I18nProvider>)
    expect(screen.queryByRole('navigation', { name: settingsNavigationCopy.en.navigation })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: settingsNavigationCopy.en.connection })).toBeVisible()
    expect(consumeSettingsCategoryRequest()).toBe('monitoring')
  })
})
