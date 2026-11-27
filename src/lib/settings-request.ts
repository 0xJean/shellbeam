/** Lets another surface open Settings on a given category (e.g. the probe installer → Monitoring). */
export type SettingsCategory = 'general' | 'connection' | 'monitoring' | 'integrations' | 'security' | 'advanced'
export const SETTINGS_CATEGORY_REQUEST_EVENT = 'shellbeam:settings-category-request'
export const SETTINGS_OPEN_EVENT = 'shellbeam:open-settings-category'

let pending: SettingsCategory | null = null
let pendingSubtab: string | null = null

export function requestSettingsCategory(category: SettingsCategory, subtab?: string) {
  pending = category
  pendingSubtab = subtab ?? null
  window.dispatchEvent(new CustomEvent(SETTINGS_CATEGORY_REQUEST_EVENT, { detail: { category, subtab: pendingSubtab } }))
}

/** Switches the main navigation to Settings and opens the given category. */
export function openSettingsCategory(category: SettingsCategory, subtab?: string) {
  requestSettingsCategory(category, subtab)
  window.dispatchEvent(new CustomEvent(SETTINGS_OPEN_EVENT, { detail: { category, subtab: pendingSubtab } }))
}

export function consumeSettingsCategoryRequest(): SettingsCategory | null {
  const value = pending
  pending = null
  return value
}

export function consumeSettingsSubtabRequest(): string | null {
  const value = pendingSubtab
  pendingSubtab = null
  return value
}
