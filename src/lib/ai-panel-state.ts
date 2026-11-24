const STORAGE_KEY = 'shellbeam.aiPanelOpenByHost'
const MAX_STORED_HOSTS = 200

export interface AiPanelHostTarget {
  vaultId?: string | null
  hostId?: string | null
  username?: string | null
  hostAddress?: string | null
}

/** Stable per-server key for remembering whether the AI assistant panel was left open. */
export function aiPanelHostKey(target: AiPanelHostTarget): string | null {
  const vault = target.vaultId?.trim() || 'none'
  const hostId = target.hostId?.trim()
  if (hostId && hostId !== 'local') return `${vault}:host:${hostId}`
  const address = target.hostAddress?.trim()
  if (!address) return null
  const username = target.username?.trim() || ''
  return `${vault}:addr:${username}@${address}`
}

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function readHostAiPanelOpen(key: string | null): boolean {
  if (!key) return false
  return readMap()[key] === true
}

export function writeHostAiPanelOpen(key: string | null, open: boolean): void {
  if (!key) return
  try {
    const map = readMap()
    delete map[key]
    map[key] = open
    const keys = Object.keys(map)
    if (keys.length > MAX_STORED_HOSTS) {
      for (const stale of keys.slice(0, keys.length - MAX_STORED_HOSTS)) {
        delete map[stale]
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable (private mode / quota); keep in-memory state only.
  }
}
