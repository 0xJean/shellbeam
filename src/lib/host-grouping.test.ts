import { describe, expect, it } from 'vitest'
import { hostBucket } from './host-grouping'

describe('hostBucket', () => {
  it('sinks unreachable hosts to offline', () => {
    expect(hostBucket('offline', 3, [99])).toBe('offline')
    expect(hostBucket('jump-unavailable', 0, [])).toBe('offline')
  })
  it('raises open alerts, stale data and critical usage', () => {
    expect(hostBucket('online', 1, [10])).toBe('attention')
    expect(hostBucket('stale', 0, [])).toBe('attention')
    expect(hostBucket('online', 0, [12, 40, 91])).toBe('attention')
  })
  it('keeps moderately busy hosts healthy', () => {
    expect(hostBucket('online', 0, [42, 68, 51])).toBe('normal')
    expect(hostBucket(undefined, 0, [null, undefined])).toBe('normal')
  })
})
