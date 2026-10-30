const DAY_MS = 86_400_000

export function startOfDay(ts: number) {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addDays(dayStart: number, days: number) {
  const date = new Date(dayStart)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(ts: number) {
  return (new Date(ts).getDay() + 6) % 7
}

export interface DayGroup<T> {
  dayStart: number
  /** 0 today, 1 yesterday, … (negative for future timestamps). */
  daysAgo: number
  items: T[]
}

/** Groups entries (any order) by local calendar day, newest day first, preserving order inside a day. */
export function groupEntriesByDay<T extends { createdAt: number }>(entries: T[], now: number): DayGroup<T>[] {
  const today = startOfDay(now)
  const groups = new Map<number, T[]>()
  for (const entry of entries) {
    const key = startOfDay(entry.createdAt)
    const list = groups.get(key)
    if (list) list.push(entry)
    else groups.set(key, [entry])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([dayStart, items]) => ({ dayStart, daysAgo: Math.round((today - dayStart) / DAY_MS), items }))
}

export interface HeatmapCell { dayStart: number; count: number; future: boolean }

export interface ActivityHeatmap {
  /** columns[week][weekday], oldest week first, Monday first. */
  columns: HeatmapCell[][]
  total: number
  max: number
  firstDay: number
}

/** GitHub-style calendar: `weeks` Monday-started columns ending with the current week. */
export function buildActivityHeatmap(timestamps: number[], now: number, weeks = 12): ActivityHeatmap {
  const today = startOfDay(now)
  const firstDay = addDays(today, -weekdayIndex(today) - (weeks - 1) * 7)
  const counts = new Map<number, number>()
  for (const ts of timestamps) {
    const day = startOfDay(ts)
    if (day < firstDay || day > today) continue
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  let total = 0
  let max = 0
  const columns = Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
    const dayStart = addDays(firstDay, week * 7 + weekday)
    const count = counts.get(dayStart) ?? 0
    total += count
    max = Math.max(max, count)
    return { dayStart, count, future: dayStart > today }
  }))
  return { columns, total, max, firstDay }
}

/** 0 for empty, otherwise 1–4 relative to the busiest day. */
export function heatmapLevel(count: number, max: number) {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil(count / max * 4)))
}

/** Counts per day for the last `days` days ending today, oldest first. */
export function dailyCounts(timestamps: number[], now: number, days = 7) {
  const today = startOfDay(now)
  const first = addDays(today, -(days - 1))
  const counts = Array.from({ length: days }, () => 0)
  for (const ts of timestamps) {
    const day = startOfDay(ts)
    if (day < first || day > today) continue
    counts[Math.round((day - first) / DAY_MS)] += 1
  }
  return counts
}

export function withinDays(ts: number, now: number, days: number) {
  return ts >= addDays(startOfDay(now), -(days - 1)) && ts <= now + DAY_MS
}

/** Hosts ranked by count, ties broken by name. */
export function rankHosts<T>(entries: T[], keyOf: (entry: T) => string | null, limit = 5) {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = keyOf(entry)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([aName, a], [bName, b]) => b - a || aName.localeCompare(bName))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}
