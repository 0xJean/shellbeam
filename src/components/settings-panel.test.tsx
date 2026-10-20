import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
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
  terminalPrefs: { fontSize: 14, fontFamily: 'Menlo', themeId: 'default' },
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
      copy.general, copy.connection, copy.monitoring, copy.integrations, copy.advanced,
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

    fireEvent.click(screen.getByTestId('settings-category-monitoring'))
    expect(screen.getByTestId('notification-settings')).toBeVisible()
    expect(screen.queryByTestId('komari-settings')).not.toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: copy.integrations }))
    expect(screen.getByTestId('komari-settings')).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.ai'] })).toBeVisible()
    fireEvent.click(within(nav).getByRole('button', { name: copy.advanced }))
    for (const id of ['mcp-settings', 'agent-settings', 'probe-retry-settings']) expect(screen.getByTestId(id)).toBeVisible()
    expect(screen.getByRole('heading', { name: text['settings.dangerZone'] })).toBeVisible()
    expect(screen.queryByTestId('komari-settings')).not.toBeInTheDocument()
  })
})
