import { afterEach, describe, expect, it, vi } from 'vitest'
import en from './locales/en'
import zhCN from './locales/zh-CN'
import { GUIDE_CHAPTERS, GUIDE_PROGRESS_KEY, loadGuideProgress, parseGuideProgress, saveGuideProgress } from './user-guide'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('guide progress', () => {
  it.each([null, '', '{broken', 'null', '42', '[]'])('handles missing or corrupt data: %s', (raw) => {
    expect(parseGuideProgress(raw)).toEqual({ current: 'vault', read: [] })
  })
  it('validates chapter IDs and removes duplicates', () => {
    expect(parseGuideProgress(JSON.stringify({ current: 'removed', read: ['hosts', 'hosts', null, 'mcp', 'removed'] })))
      .toEqual({ current: 'vault', read: ['hosts', 'mcp'] })
  })
  it('round-trips reading progress only', () => {
    expect(saveGuideProgress({ current: 'monitor', read: ['vault', 'hosts'] })).toBe(true)
    expect(loadGuideProgress()).toEqual({ progress: { current: 'monitor', read: ['vault', 'hosts'] }, storageAvailable: true })
    expect(Object.keys(JSON.parse(localStorage.getItem(GUIDE_PROGRESS_KEY)!))).toEqual(['current', 'read'])
  })
  it('can still read the guide when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(loadGuideProgress()).toEqual({ progress: { current: 'vault', read: [] }, storageAvailable: false })
    expect(saveGuideProgress({ current: 'hosts', read: [] })).toBe(false)
  })
})

describe('guide translations', () => {
  it('has matching nonempty English and Chinese keys and parameters', () => {
    const keys = (dictionary: Record<string, string>) => Object.keys(dictionary).filter((key) => key.startsWith('guide.') || key.startsWith('welcome.')).sort()
    expect(keys(en)).toEqual(keys(zhCN))
    for (const key of keys(en)) {
      expect(en[key].trim(), key).not.toBe('')
      expect(zhCN[key].trim(), key).not.toBe('')
      expect(en[key].match(/\{\w+\}/g), key).toEqual(zhCN[key].match(/\{\w+\}/g))
    }
  })
  it('provides every chapter, step, and destination label in both languages', () => {
    for (const chapter of GUIDE_CHAPTERS) {
      const keys = ['title', 'summary', 'note'].map((suffix) => `guide.${chapter.id}.${suffix}`)
      for (let i = 1; i <= chapter.steps; i++) keys.push(`guide.${chapter.id}.step${i}.title`, `guide.${chapter.id}.step${i}.body`)
      keys.push(...chapter.actions.map((action) => action.label))
      for (const key of keys) {
        expect(en[key], key).toBeTruthy()
        expect(zhCN[key], key).toBeTruthy()
      }
    }
  })
})
