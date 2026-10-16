import { describe, expect, it } from 'vitest'
import en from './locales/en'
import zhCN from './locales/zh-CN'

const komariSettingsKeys = Object.keys(en)
  .filter((key) => key.startsWith('settings.komari'))
  .sort()

describe('Komari settings translations', () => {
  it('provides matching nonempty English and Chinese copy', () => {
    expect(komariSettingsKeys.length).toBeGreaterThan(0)
    expect(komariSettingsKeys).toEqual(
      Object.keys(zhCN).filter((key) => key.startsWith('settings.komari')).sort(),
    )
    for (const key of komariSettingsKeys) {
      expect(en[key].trim(), key).not.toBe('')
      expect(zhCN[key].trim(), key).not.toBe('')
      expect(en[key].match(/\{\w+\}/g), key).toEqual(zhCN[key].match(/\{\w+\}/g))
    }
  })
})
