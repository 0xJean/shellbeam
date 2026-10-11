import type { SidebarNavId } from '@/components/pc-nav-sidebar'

export type GuideDestination = Exclude<SidebarNavId, 'terminal' | 'guide'> | 'add-host'

export const GUIDE_CHAPTERS = [
  { id: 'vault', steps: 3, actions: [{ destination: 'keychain', label: 'guide.openKeychain' }] },
  { id: 'hosts', steps: 3, actions: [{ destination: 'add-host', label: 'guide.addHost' }] },
  { id: 'connect', steps: 3, actions: [{ destination: 'hosts', label: 'guide.openHosts' }, { destination: 'known-hosts', label: 'guide.openKnownHosts' }] },
  { id: 'monitor', steps: 4, actions: [{ destination: 'asset-inventory', label: 'guide.openAssets' }] },
  { id: 'workspace', steps: 4, actions: [{ destination: 'sftp', label: 'guide.openSftp' }, { destination: 'port-forwarding', label: 'guide.openTunnels' }, { destination: 'snippets', label: 'guide.openSnippets' }] },
  { id: 'mcp', steps: 4, actions: [{ destination: 'settings', label: 'guide.openMcp' }] },
  { id: 'backup', steps: 3, actions: [{ destination: 'backup', label: 'guide.openBackup' }, { destination: 'sync', label: 'guide.openSync' }] },
  { id: 'troubleshooting', steps: 5, actions: [{ destination: 'hosts', label: 'guide.openHosts' }, { destination: 'settings', label: 'guide.openSettings' }] },
] as const satisfies ReadonlyArray<{
  id: string
  steps: number
  actions: ReadonlyArray<{ destination: GuideDestination; label: string }>
}>

export type GuideChapterId = (typeof GUIDE_CHAPTERS)[number]['id']
export interface GuideProgress {
  current: GuideChapterId
  read: GuideChapterId[]
}

export const GUIDE_PROGRESS_KEY = 'shellbeam.guide.v1'

function isChapterId(value: unknown): value is GuideChapterId {
  return GUIDE_CHAPTERS.some((chapter) => chapter.id === value)
}

export function parseGuideProgress(raw: string | null): GuideProgress {
  const fallback: GuideProgress = { current: 'vault', read: [] }
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const data = parsed as Record<string, unknown>
    return {
      current: isChapterId(data.current) ? data.current : 'vault',
      read: Array.isArray(data.read) ? [...new Set(data.read.filter(isChapterId))] : [],
    }
  } catch {
    return fallback
  }
}

export function loadGuideProgress(): { progress: GuideProgress; storageAvailable: boolean } {
  try {
    return { progress: parseGuideProgress(localStorage.getItem(GUIDE_PROGRESS_KEY)), storageAvailable: true }
  } catch {
    return { progress: parseGuideProgress(null), storageAvailable: false }
  }
}

export function saveGuideProgress(progress: GuideProgress): boolean {
  try {
    localStorage.setItem(GUIDE_PROGRESS_KEY, JSON.stringify(progress))
    return true
  } catch {
    return false
  }
}
