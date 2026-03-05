const STORAGE_KEY = 'shellbeam.interactiveHistory'
const MAX_PER_HOST = 200

export interface InteractiveCommand {
  command: string
  timestamp: number
}

type HostHistoryMap = Record<string, InteractiveCommand[]>

let cache: HostHistoryMap | null = null

function loadAll(): HostHistoryMap {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cache = raw ? JSON.parse(raw) : {}
  } catch { cache = {} }
  return cache!
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!cache) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)) } catch {}
  }, 300)
}

let listeners = new Set<(host: string) => void>()

export function subscribeInteractiveHistory(cb: (host: string) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function recordInteractiveCommand(hostAddress: string, command: string) {
  const trimmed = command.trim()
  if (!trimmed || !hostAddress) return

  const map = loadAll()
  const list = map[hostAddress] ?? []
  list.push({ command: trimmed, timestamp: Date.now() })
  if (list.length > MAX_PER_HOST) list.splice(0, list.length - MAX_PER_HOST)
  map[hostAddress] = list

  scheduleSave()
  queueMicrotask(() => {
    for (const cb of listeners) cb(hostAddress)
  })
}

export function getInteractiveHistory(hostAddress: string): InteractiveCommand[] {
  if (!hostAddress) return []
  return loadAll()[hostAddress] ?? []
}
