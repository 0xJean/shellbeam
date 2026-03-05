import { useEffect, useState, useCallback } from 'react'
import { listCommandHistory, type HistoryEntry, type HistoryFilter } from '@/lib/history'

export function useCommandHistory(filter?: HistoryFilter) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    setLoading(true)
    listCommandHistory(filter)
      .then((res) => setEntries(res.reverse()))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [filter?.host, filter?.status])

  useEffect(() => { refresh() }, [refresh])

  return { entries, loading, refresh }
}
