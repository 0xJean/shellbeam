import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'

interface ApprovalRequest {
  requestId: string
  peerDeviceId: string
  peerName: string
  vaultId: string
  vaultName: string
  expiresAt: number
}

/**
 * Asks before a paired device receives this device's decrypted vault secrets.
 * The backend denies on its own timeout; this only has to put the question up.
 * Dismissing the dialog in any way other than Allow answers no.
 */
export function SyncVaultExportApproval() {
  const { t } = useT()
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const current = queue[0]
  const currentRef = useRef(current)
  useEffect(() => { currentRef.current = current }, [current])

  const answer = useCallback((approved: boolean) => {
    const request = currentRef.current
    if (!request) return
    setQueue((items) => items.filter((item) => item.requestId !== request.requestId))
    void invoke('sync_resolve_vault_export', { payload: { requestId: request.requestId, approved } }).catch(() => {})
  }, [])

  useEffect(() => {
    const unlisten = listen<ApprovalRequest>('sync-vault-export-approval', (event) => {
      setQueue((items) => [...items, event.payload])
    })
    return () => { void unlisten.then((stop) => stop()) }
  }, [])

  // Once the backend has given up, the question is no longer open.
  useEffect(() => {
    if (!current) return
    const timer = window.setTimeout(() => answer(false), Math.max(0, current.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [current, answer])

  if (!current) return null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) answer(false) }}>
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--workspace-status-warn-text)]" />
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{t('sync.vaultExportTitle')}</h2>
            <p className="break-words text-sm text-muted-foreground">
              {t('sync.vaultExportBody', { peer: current.peerName, vault: current.vaultName })}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" data-autofocus onClick={() => answer(false)}>{t('sync.vaultExportDeny')}</Button>
          <Button variant="destructive" onClick={() => answer(true)}>{t('sync.vaultExportAllow')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
