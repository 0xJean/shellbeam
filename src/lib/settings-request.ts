/** Lets another surface open Settings on a given category (e.g. the probe installer → Monitoring). */
export type SettingsCategory = 'general' | 'connection' | 'monitoring' | 'integrations' | 'security' | 'advanced'
export const SETTINGS_CATEGORY_REQUEST_EVENT = 'shellbeam:settings-category-request'
export const SETTINGS_OPEN_EVENT = 'shellbeam:open-settings-category'

let pending: SettingsCategory | null = null

export function requestSettingsCategory(category: SettingsCategory) {
  pending = category
  window.dispatchEvent(new CustomEvent(SETTINGS_CATEGORY_REQUEST_EVENT, { detail: category }))
}

/** Switches the main navigation to Settings and opens the given category. */
export function openSettingsCategory(category: SettingsCategory) {
  requestSettingsCategory(category)
  window.dispatchEvent(new CustomEvent(SETTINGS_OPEN_EVENT, { detail: category }))
}

export function consumeSettingsCategoryRequest(): SettingsCategory | null {
  const value = pending
  pending = null
  return value
}
