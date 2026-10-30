import type { SettingsCategory } from './settings-request'

/** One walkthrough per guide chapter, keyed by the chapter id. */
export const INTERACTIVE_TOURS = ['vault', 'hosts', 'connect', 'monitor', 'workspace', 'mcp', 'backup', 'troubleshooting'] as const
export type InteractiveTourId = (typeof INTERACTIVE_TOURS)[number]
export type TourOutcome = 'completed' | 'cancelled' | 'unavailable' | 'interrupted'

export const TOUR_ROUTES = {
  vault: 'keychain', hosts: 'hosts', connect: 'known-hosts', monitor: 'asset-inventory',
  workspace: 'snippets', mcp: 'settings', backup: 'sync', troubleshooting: 'activity',
} as const
export const TOUR_READY = {
  vault: '[data-tour="keychain-page"]',
  hosts: '[data-tour="host-create"]',
  connect: '[data-tour="known-hosts-page"]',
  monitor: '[data-tour="monitor-page"]',
  workspace: '[data-tour="snippets-page"]',
  mcp: '[data-tour="mcp-settings"][data-tour-ready="true"]',
  backup: '[data-tour="sync-card"]',
  troubleshooting: '[data-tour="history-page"]',
} as const
/** Settings tours open their category first; the panel starts on General. */
export const TOUR_SETTINGS_CATEGORY: Partial<Record<InteractiveTourId, SettingsCategory>> = { mcp: 'advanced' }

export interface TourStep {
  target: string
  key: string
  form?: boolean
  optional?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
}

const target = (name: string) => `[data-tour="${name}"]`
/** Sidebar entries already carry stable test ids (`pc-nav-<id>`). */
const nav = (id: string) => `[data-testid="pc-nav-${id}"]`
const monitorTarget = (name: string) => `[data-tour="monitor-page"] ${target(name)}`

export const TOUR_STEPS: Record<InteractiveTourId, readonly TourStep[]> = {
  // Sidebar steps are optional: the sidebar is hidden on phones.
  vault: [
    { target: nav('vault'), key: 'vaultSwitcher', optional: true, side: 'right' },
    { target: nav('vault-status'), key: 'vaultStatus', optional: true, side: 'right' },
    { target: target('keychain-actions'), key: 'keychainActions' },
    { target: target('keychain-list'), key: 'keychainList' },
  ],
  hosts: [
    { target: target('host-create'), key: 'hostCreate' },
    { target: `${target('host-form')} ${target('host-address')}`, key: 'hostAddress', form: true },
    { target: `${target('host-form')} ${target('host-identity')}`, key: 'hostIdentity', form: true },
    { target: `${target('host-form')} ${target('host-auth')}`, key: 'hostAuth', form: true },
    { target: `${target('host-form')} ${target('host-save')}`, key: 'hostSave', form: true },
  ],
  connect: [
    { target: target('known-hosts-header'), key: 'knownHostsHeader' },
    { target: target('known-hosts-list'), key: 'knownHostsList' },
    { target: nav('hosts'), key: 'connectFromHosts', optional: true, side: 'right' },
  ],
  monitor: [
    { target: target('monitor-page'), key: 'monitorPage' },
    { target: monitorTarget('monitor-servers'), key: 'monitorServers', optional: true },
    { target: monitorTarget('monitor-status'), key: 'monitorStatus', optional: true },
    { target: monitorTarget('monitor-resources'), key: 'monitorResources', optional: true },
    { target: monitorTarget('monitor-source'), key: 'monitorSource', optional: true },
    { target: monitorTarget('monitor-trends'), key: 'monitorTrends', optional: true },
  ],
  workspace: [
    { target: nav('sftp'), key: 'workspaceSftp', optional: true, side: 'right' },
    { target: nav('port-forwarding'), key: 'workspaceTunnels', optional: true, side: 'right' },
    { target: target('snippet-create'), key: 'snippetCreate' },
    { target: target('snippet-variables'), key: 'snippetVariables' },
    { target: nav('search'), key: 'workspaceSearch', optional: true, side: 'right' },
  ],
  mcp: [
    { target: target('mcp-toggle'), key: 'mcpToggle' },
    { target: target('mcp-client'), key: 'mcpClient', optional: true },
    { target: target('mcp-hosts'), key: 'mcpHosts', optional: true },
    { target: target('mcp-permissions'), key: 'mcpPermissions', optional: true },
    { target: target('mcp-create'), key: 'mcpCreate', optional: true },
    { target: target('mcp-clients'), key: 'mcpClients', optional: true },
  ],
  backup: [
    { target: target('sync-card'), key: 'syncCard' },
    // The backup card is absent while a paired device's detail view is open.
    { target: target('backup-data'), key: 'backupData', optional: true },
    { target: target('backup-password'), key: 'backupPassword', optional: true },
    { target: target('backup-create'), key: 'backupCreate', optional: true },
    { target: target('backup-restore'), key: 'backupRestore', optional: true },
  ],
  troubleshooting: [
    { target: target('history-tabs'), key: 'historyTabs' },
    { target: target('history-filters'), key: 'historyFilters', optional: true },
    { target: target('history-timeline'), key: 'historyTimeline', optional: true },
    { target: nav('known-hosts'), key: 'troubleKnownHosts', optional: true, side: 'right' },
    { target: nav('settings'), key: 'troubleSettings', optional: true, side: 'right' },
  ],
}

export function findTourTarget(selector: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => {
    const style = getComputedStyle(element)
    return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
}

export function waitForTourTarget(selector: string, signal: AbortSignal, timeoutMs = 5000): Promise<HTMLElement | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(undefined); return }
    const current = findTourTarget(selector)
    if (current) { resolve(current); return }
    const finish = (element?: HTMLElement) => {
      observer.disconnect()
      window.clearTimeout(timeout)
      window.clearInterval(poll)
      signal.removeEventListener('abort', abort)
      resolve(element)
    }
    const check = () => {
      const element = findTourTarget(selector)
      if (element) finish(element)
    }
    const abort = () => finish()
    const observer = new MutationObserver(check)
    const timeout = window.setTimeout(() => finish(), timeoutMs)
    // CSS transitions can reveal a target without a DOM mutation.
    const poll = window.setInterval(check, 100)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    signal.addEventListener('abort', abort, { once: true })
  })
}
