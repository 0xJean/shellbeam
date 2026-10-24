import assert from 'node:assert/strict'

// /api/recent is a short raw window. Retention must be checked against the
// metric-store history API, independently of the unchanged raw freshness gate.
export function historyTimes(value, node, depth = 0) {
  if (depth > 5 || !value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => historyTimes(item, node, depth + 1))
  if (['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some(key => key in value)) {
    assert.equal(value.client, node, 'transfer_history_node_mismatch')
    const time = Date.parse(value.time)
    assert(Number.isSafeInteger(time) && time > 0, 'transfer_history_original_time_missing')
    return [time]
  }
  return ['records', 'data', 'result'].flatMap(key => historyTimes(value[key], node, depth + 1))
}

export function transferHistory(request, node, wait) {
  let baseline
  const read = async () => new Set(historyTimes((await request(`/api/records/load?uuid=${encodeURIComponent(node)}&load_type=all&hours=1`)).value, node))
  return {
    capture: async () => {
      if (!baseline) baseline = await wait(async () => { const times = await read(); return times.size ? times : false })
      return [...baseline].sort((a, b) => a - b)
    },
    retained: async () => {
      assert(baseline?.size, 'transfer_history_baseline_missing')
      const times = await read()
      for (const time of baseline) assert(times.has(time), 'transfer_history_original_bucket_missing')
      return { originalBuckets: [...baseline].sort((a, b) => a - b), retainedBuckets: times.size, checkedAt: Date.now() }
    },
  }
}
