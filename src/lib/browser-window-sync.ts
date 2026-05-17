import type { BrowserSource } from '@/lib/browser'

interface SyncBrowserWindowParams {
  browserId: string
  sessionId: string
  wasOpen: boolean
  lastSourceRevision?: number
  sourceRevision: number
  source: BrowserSource | null
  openBrowser: (params: { browserId: string; sessionId: string }) => Promise<void>
  loadSource: (params: { browserId: string; sessionId: string; source: BrowserSource }) => Promise<void>
}

export async function syncBrowserWindow({
  browserId,
  sessionId,
  wasOpen,
  lastSourceRevision,
  sourceRevision,
  source,
  openBrowser,
  loadSource,
}: SyncBrowserWindowParams): Promise<number | undefined> {
  if (!wasOpen) {
    await openBrowser({ browserId, sessionId })
  }

  if (!source || lastSourceRevision === sourceRevision) {
    return lastSourceRevision
  }

  await loadSource({ browserId, sessionId, source })

  return sourceRevision
}
