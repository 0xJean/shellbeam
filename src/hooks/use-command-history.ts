import { useEffect, useState, useCallback } from 'react'
import { listCommandHistory, type HistoryEntry, type HistoryFilter } from '@/lib/history'

export function useCommandHistory(vaultId: string | undefined, filter?: HistoryFilter) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    setLoading(true)
    listCommandHistory(vaultId, filter)
      .then((res) => setEntries(res.reverse()))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [vaultId, filter?.host, filter?.status])

  useEffect(() => { refresh() }, [refresh])

  return { entries, loading, refresh }
}
