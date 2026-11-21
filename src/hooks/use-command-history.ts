import { useEffect, useState, useCallback } from 'react'
import { listCommandHistory, type HistoryEntry, type HistoryFilter } from '@/lib/history'

export function useCommandHistory(vaultId: string | undefined, filter?: HistoryFilter) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const filterHost = filter?.host
  const filterStatus = filter?.status

  const refresh = useCallback(() => {
    setLoading(true)
    const activeFilter: HistoryFilter | undefined =
      filterHost !== undefined || filterStatus !== undefined
        ? { host: filterHost, status: filterStatus }
        : undefined
    listCommandHistory(vaultId, activeFilter)
      .then((res) => setEntries(res.reverse()))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [vaultId, filterHost, filterStatus])

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) refresh()
    })
    return () => { cancelled = true }
  }, [refresh])

  return { entries, loading, refresh }
}
