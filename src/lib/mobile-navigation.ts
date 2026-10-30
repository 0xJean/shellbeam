import type { SidebarNavId } from '@/components/pc-nav-sidebar'

/** Pages reached from the mobile Tools tab; the tab stays highlighted while one is open. */
export const MOBILE_TOOL_PAGES: readonly SidebarNavId[] = ['tools', 'port-forwarding', 'asset-inventory', 'known-hosts', 'keychain', 'snippets', 'activity', 'sync', 'backup', 'guide']

export function isToolPage(nav: SidebarNavId) {
  return MOBILE_TOOL_PAGES.includes(nav)
}
