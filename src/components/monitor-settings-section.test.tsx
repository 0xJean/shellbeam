import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { listKomariIntegrations } from '@/lib/komari-config'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { MonitorSettingsSection } from './monitor-settings-section'

const vault = vi.hoisted(() => ({ unlocked: true }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'v', vaultStatusState: { unlocked: vault.unlocked } }) }))
vi.mock('@/lib/komari-config', () => ({ listKomariIntegrations: vi.fn() }))
vi.mock('./komari-settings-section', () => ({ KomariSettingsSection: () => <div data-testid="komari-settings" /> }))
vi.mock('./host-notification-rules-panel', () => ({ HostRuleSettingsSection: ({ emptyState }: { emptyState?: React.ReactNode }) => <div data-testid="host-rules">{emptyState}</div> }))
vi.mock('./notification-settings-section', () => ({ NotificationSettingsSection: () => <div data-testid="notification-settings" /> }))
vi.mock('./monitoring-service-panel', () => ({ MonitoringServicePanel: ({ service, initialTarget }: { service: { name: string }; initialTarget: string }) => <div data-testid="service-panel">{service.name}:{initialTarget}</div> }))

const copy = monitorSettingsCopy.en
const service = (id: string, name: string) => ({ id, vaultId: 'v', name, endpoint: `https://${id}.test`, credentialRef: '', enabled: true, createdAt: 1, updatedAt: 1 })

describe('MonitorSettingsSection', () => {
  beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vault.unlocked = true; vi.mocked(listKomariIntegrations).mockResolvedValue([service('a', 'Prod'), service('b', 'Test')]) })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('switches between the five monitoring pages', async () => {
    render(<I18nProvider><MonitorSettingsSection /></I18nProvider>)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent?.replace(/\d+$/, ''))).toEqual([copy.tabServices, copy.tabServer, copy.tabRules, copy.tabOffline, copy.tabLocal])
    expect(screen.getByTestId('komari-settings')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('tab', { name: new RegExp(`^${copy.tabServices}\\s*2$`) })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.click(screen.getByRole('tab', { name: copy.tabServer }))
    expect(await screen.findByTestId('service-panel')).toHaveTextContent('Prod:settings')
    fireEvent.click(screen.getByRole('button', { name: /Test/ }))
    expect(screen.getByTestId('service-panel')).toHaveTextContent('Test:settings')
    fireEvent.click(screen.getByRole('tab', { name: copy.tabRules }))
    expect(await screen.findByTestId('service-panel')).toHaveTextContent('Test:load-policy')
    fireEvent.click(screen.getByRole('tab', { name: copy.tabOffline }))
    expect(screen.getByText(copy.offlineEmpty)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: copy.tabLocal }))
    expect(screen.getByTestId('notification-settings')).toBeInTheDocument()
  })

  it('does not read server configuration while the Vault is locked', () => {
    vault.unlocked = false
    render(<I18nProvider><MonitorSettingsSection initialPage="server" /></I18nProvider>)
    expect(screen.getByText(copy.lockedServer)).toBeInTheDocument()
    expect(listKomariIntegrations).not.toHaveBeenCalled()
    expect(screen.queryByTestId('service-panel')).not.toBeInTheDocument()
  })
})
