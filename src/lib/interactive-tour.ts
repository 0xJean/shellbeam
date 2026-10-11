export const INTERACTIVE_TOURS = ['hosts', 'monitor', 'mcp'] as const
export type InteractiveTourId = (typeof INTERACTIVE_TOURS)[number]
export type TourOutcome = 'completed' | 'cancelled' | 'unavailable' | 'interrupted'

export const TOUR_ROUTES = { hosts: 'hosts', monitor: 'asset-inventory', mcp: 'settings' } as const
export const TOUR_READY = { hosts: '[data-tour="host-create"]', monitor: '[data-tour="monitor-page"]', mcp: '[data-tour="mcp-settings"][data-tour-ready="true"]' } as const

export interface TourStep {
  target: string
  key: string
  form?: boolean
  optional?: boolean
}

const target = (name: string) => `[data-tour="${name}"]`
const monitorTarget = (name: string) => `[data-tour="monitor-page"] ${target(name)}`

export const TOUR_STEPS: Record<InteractiveTourId, readonly TourStep[]> = {
  hosts: [
    { target: target('host-create'), key: 'hostCreate' },
    { target: `${target('host-form')} ${target('host-address')}`, key: 'hostAddress', form: true },
    { target: `${target('host-form')} ${target('host-identity')}`, key: 'hostIdentity', form: true },
    { target: `${target('host-form')} ${target('host-auth')}`, key: 'hostAuth', form: true },
    { target: `${target('host-form')} ${target('host-save')}`, key: 'hostSave', form: true },
  ],
  monitor: [
    { target: target('monitor-page'), key: 'monitorPage' },
    { target: monitorTarget('monitor-servers'), key: 'monitorServers', optional: true },
    { target: monitorTarget('monitor-status'), key: 'monitorStatus', optional: true },
    { target: monitorTarget('monitor-resources'), key: 'monitorResources', optional: true },
    { target: monitorTarget('monitor-source'), key: 'monitorSource', optional: true },
    { target: monitorTarget('monitor-trends'), key: 'monitorTrends', optional: true },
  ],
  mcp: [
    { target: target('mcp-toggle'), key: 'mcpToggle' },
    { target: target('mcp-client'), key: 'mcpClient', optional: true },
    { target: target('mcp-hosts'), key: 'mcpHosts', optional: true },
    { target: target('mcp-permissions'), key: 'mcpPermissions', optional: true },
    { target: target('mcp-create'), key: 'mcpCreate', optional: true },
    { target: target('mcp-clients'), key: 'mcpClients', optional: true },
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
