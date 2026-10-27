/** Lets another surface open Settings on a given category (e.g. the probe installer → Monitoring). */
export type SettingsCategory = 'general' | 'connection' | 'monitoring' | 'integrations' | 'advanced'
export const SETTINGS_CATEGORY_REQUEST_EVENT = 'shellbeam:settings-category-request'

let pending: SettingsCategory | null = null

export function requestSettingsCategory(category: SettingsCategory) {
  pending = category
  window.dispatchEvent(new CustomEvent(SETTINGS_CATEGORY_REQUEST_EVENT, { detail: category }))
}

export function consumeSettingsCategoryRequest(): SettingsCategory | null {
  const value = pending
  pending = null
  return value
}
