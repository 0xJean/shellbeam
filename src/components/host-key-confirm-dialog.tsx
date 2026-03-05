import { useT } from '@/lib/i18n'
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

export interface HostKeyInfo {
  code: 'host_key_unknown' | 'host_key_mismatch'
  host: string
  port: number
  fingerprint: string
  keyType: string
}

interface HostKeyConfirmDialogProps {
  info: HostKeyInfo | null
  onAccept: () => void
  onReject: () => void
}

export function HostKeyConfirmDialog({ info, onAccept, onReject }: HostKeyConfirmDialogProps) {
  const { t } = useT()

  if (!info) return null

  const isMismatch = info.code === 'host_key_mismatch'

  return (
    <Dialog open={!!info} onOpenChange={(open) => { if (!open) onReject() }}>
      <DialogContent className="md:max-w-lg">
        <div className="space-y-4 p-6">
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${isMismatch ? 'bg-destructive/10' : 'bg-amber-500/10'}`}>
              {isMismatch
                ? <ShieldX className="h-6 w-6 text-destructive" />
                : <ShieldAlert className="h-6 w-6 text-amber-500" />
              }
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold">
                {isMismatch ? t('hostKey.changed') : t('hostKey.unknown')}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {isMismatch
                  ? t('hostKey.changedDesc')
                  : t('hostKey.unknownDesc')
                }
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="shrink-0 font-medium text-muted-foreground">{t('hostKey.host')}</span>
              <span className="min-w-0 truncate font-mono">{info.host}:{info.port}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="shrink-0 font-medium text-muted-foreground">{t('hostKey.type')}</span>
              <span className="font-mono">{info.keyType}</span>
            </div>
            <div className="space-y-1 text-sm">
              <span className="font-medium text-muted-foreground">{t('hostKey.fingerprint')}</span>
              <p className="break-all rounded bg-background p-2 font-mono text-xs">
                SHA256:{info.fingerprint}
              </p>
            </div>
          </div>

          {isMismatch && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">
                {t('hostKey.warning')}
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <Button variant="outline" onClick={onReject}>
              {t('hostKey.cancel')}
            </Button>
            {!isMismatch && (
              <Button onClick={onAccept} className="gap-2">
                <ShieldCheck className="h-4 w-4" />
                {t('hostKey.trustConnect')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function parseHostKeyError(errorMessage: string): HostKeyInfo | null {
  try {
    const parsed = JSON.parse(errorMessage)
    if (parsed.code === 'host_key_unknown' || parsed.code === 'host_key_mismatch') {
      return {
        code: parsed.code,
        host: parsed.host ?? '',
        port: parsed.port ?? 22,
        fingerprint: parsed.fingerprint ?? '',
        keyType: parsed.keyType ?? parsed.key_type ?? 'unknown',
      }
    }
  } catch {
    if (errorMessage.includes('host_key_unknown') || errorMessage.includes('host_key_mismatch')) {
      try {
        const jsonStart = errorMessage.indexOf('{')
        if (jsonStart >= 0) {
          return parseHostKeyError(errorMessage.slice(jsonStart))
        }
      } catch { /* not parseable */ }
    }
  }
  return null
}
