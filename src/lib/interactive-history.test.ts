import { beforeEach, describe, expect, it } from 'vitest'
import { getInteractiveHistory, recordInteractiveCommand, resetInteractiveHistoryCacheForTests } from './interactive-history'

const LEGACY_KEY = 'shellbeam.interactiveHistory'

describe('interactive history', () => {
  beforeEach(() => {
    localStorage.clear()
    resetInteractiveHistoryCacheForTests()
  })

  it('keeps typed commands separate per vault', () => {
    recordInteractiveCommand('vault-a', '10.0.0.1', 'uptime')
    recordInteractiveCommand('vault-b', '10.0.0.1', 'whoami')
    expect(getInteractiveHistory('vault-a', '10.0.0.1').map((entry) => entry.command)).toEqual(['uptime'])
    expect(getInteractiveHistory('vault-b', '10.0.0.1').map((entry) => entry.command)).toEqual(['whoami'])
    expect(getInteractiveHistory(undefined, '10.0.0.1')).toEqual([])
  })

  it('moves the unscoped legacy history into Personal once', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ '10.0.0.1': [{ command: 'ls', timestamp: 1 }] }))
    localStorage.setItem(`${LEGACY_KEY}:personal`, JSON.stringify({ '10.0.0.1': [{ command: 'pwd', timestamp: 2 }] }))

    expect(getInteractiveHistory('vault-a', '10.0.0.1')).toEqual([])
    expect(getInteractiveHistory('personal', '10.0.0.1').map((entry) => entry.command)).toEqual(['ls', 'pwd'])
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(`${LEGACY_KEY}:personal`) ?? '{}')['10.0.0.1']).toHaveLength(2)

    resetInteractiveHistoryCacheForTests()
    expect(getInteractiveHistory(undefined, '10.0.0.1').map((entry) => entry.command)).toEqual(['ls', 'pwd'])
  })
})
