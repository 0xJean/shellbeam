import { describe, expect, it } from 'vitest'
import { buildActivityHeatmap, dailyCounts, groupEntriesByDay, heatmapLevel, rankHosts, startOfDay, weekdayIndex, withinDays } from './activity-timeline'

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// Friday 24 Oct 2025, 15:00 local
const NOW = at(2025, 10, 24, 15)

describe('groupEntriesByDay', () => {
  it('groups by local day newest first and keeps order within a day', () => {
    const entries = [
      { id: 'a', createdAt: at(2025, 10, 24, 10, 42) },
      { id: 'b', createdAt: at(2025, 10, 23, 22, 47) },
      { id: 'c', createdAt: at(2025, 10, 24, 9, 12) },
      { id: 'd', createdAt: at(2025, 10, 20, 8) },
    ]
    const groups = groupEntriesByDay(entries, NOW)
    expect(groups.map((g) => g.daysAgo)).toEqual([0, 1, 4])
    expect(groups[0].items.map((e) => e.id)).toEqual(['a', 'c'])
    expect(groups[0].dayStart).toBe(startOfDay(NOW))
  })

  it('returns no groups for no entries', () => {
    expect(groupEntriesByDay([], NOW)).toEqual([])
  })
})

describe('buildActivityHeatmap', () => {
  it('builds Monday-first week columns ending with the current week', () => {
    const map = buildActivityHeatmap([at(2025, 10, 24, 1), at(2025, 10, 24, 2), at(2025, 10, 20), at(2025, 7, 1)], NOW, 12)
    expect(map.columns).toHaveLength(12)
    expect(map.columns.every((col) => col.length === 7)).toBe(true)
    expect(weekdayIndex(map.firstDay)).toBe(0)
    const last = map.columns[11]
    expect(last[0].dayStart).toBe(startOfDay(at(2025, 10, 20)))
    expect(last[0].count).toBe(1)
    expect(last[4].count).toBe(2)
    expect(last[5].future).toBe(true)
    expect(map.total).toBe(3)
    expect(map.max).toBe(2)
  })

  it('ignores timestamps in the future', () => {
    expect(buildActivityHeatmap([at(2025, 10, 25)], NOW, 2).total).toBe(0)
  })
})

describe('heatmapLevel', () => {
  it('scales counts to 0-4', () => {
    expect(heatmapLevel(0, 10)).toBe(0)
    expect(heatmapLevel(1, 10)).toBe(1)
    expect(heatmapLevel(6, 10)).toBe(3)
    expect(heatmapLevel(10, 10)).toBe(4)
  })
})

describe('dailyCounts / withinDays / rankHosts', () => {
  it('counts the last days oldest first', () => {
    expect(dailyCounts([at(2025, 10, 24), at(2025, 10, 18), at(2025, 10, 17), at(2025, 10, 22, 1), at(2025, 10, 22, 23)], NOW, 7))
      .toEqual([1, 0, 0, 0, 2, 0, 1])
  })

  it('checks the rolling window by calendar day', () => {
    expect(withinDays(at(2025, 10, 18, 0, 1), NOW, 7)).toBe(true)
    expect(withinDays(at(2025, 10, 17, 23, 59), NOW, 7)).toBe(false)
  })

  it('ranks hosts by count then name', () => {
    const rows = [{ h: 'b' }, { h: 'a' }, { h: 'b' }, { h: null }, { h: 'a' }, { h: 'c' }]
    expect(rankHosts(rows, (r) => r.h, 2)).toEqual([{ name: 'a', count: 2 }, { name: 'b', count: 2 }])
  })
})
