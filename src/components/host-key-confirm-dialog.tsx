import { useEffect, useId, useState } from 'react'
import { useT } from '@/lib/i18n'
import { Info, OctagonAlert, Shield, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { listKnownHosts } from '@/lib/known-hosts'
import { connectionStatesCopy } from '@/lib/locales/connection-states'
import { requestKnownHosts } from '@/lib/navigation-request'

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

const label = (text: string) => text.replace(/[:：]\s*$/, '')

export function HostKeyConfirmDialog({ info, onAccept, onReject }: HostKeyConfirmDialogProps) {
  const { t, locale } = useT()
  const copy = connectionStatesCopy[locale] ?? connectionStatesCopy.en
  const titleId = useId()
  // The fingerprint already recorded in Known Hosts, keyed by endpoint so a stale lookup is never shown.
  const [recorded, setRecorded] = useState<{ endpoint: string; fingerprint: string } | null>(null)
  const endpoint = info ? `${info.host}:${info.port}` : ''
  const mismatchFingerprint = info?.code === 'host_key_mismatch' ? info.fingerprint : null

  useEffect(() => {
    if (!info || mismatchFingerprint === null) return
    let cancelled = false
    listKnownHosts()
      .then((entries) => {
        if (cancelled) return
        const entry = entries.find((item) => item.host === info.host && item.port === info.port)
        if (entry?.fingerprintSha256 && entry.fingerprintSha256 !== mismatchFingerprint) {
          setRecorded({ endpoint: `${info.host}:${info.port}`, fingerprint: entry.fingerprintSha256 })
        }
      })
      .catch(() => { /* Without the record only the received fingerprint is shown. */ })
    return () => { cancelled = true }
  }, [info, mismatchFingerprint])

  if (!info) return null

  const isMismatch = info.code === 'host_key_mismatch'
  const oldFingerprint = isMismatch && recorded?.endpoint === endpoint ? recorded.fingerprint : null

  return (
    <Dialog open={!!info} onOpenChange={(open) => { if (!open) onReject() }} labelledBy={titleId}>
      <DialogContent className="sb-card md:max-w-[520px] md:w-[520px]">
        <div data-testid="host-key-confirm" data-host={info.host} data-port={info.port} data-code={info.code}>
          <div className="space-y-4 px-5 pb-5 pt-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-[color:var(--workspace-text-strong)]">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isMismatch ? 'bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]' : 'bg-[color:var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]'}`}>
                    {isMismatch ? <ShieldX className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                  </span>
                  {isMismatch ? t('hostKey.changed') : t('hostKey.unknown')}
                </h3>
                <p className="mt-1.5 text-[13px] text-[color:var(--workspace-text-muted)]">
                  {isMismatch ? t('hostKey.changedDesc') : t('hostKey.unknownDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={onReject}
                aria-label={t('hostKey.cancel')}
                className="rounded-md p-1 text-[color:var(--workspace-text-subtle)] transition-colors hover:bg-[color:var(--workspace-surface-800)] hover:text-[color:var(--workspace-text-strong)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
              <dt className="text-[color:var(--workspace-text-subtle)]">{label(t('hostKey.host'))}</dt>
              <dd className="min-w-0 truncate font-mono text-[color:var(--workspace-text)]">{info.host}:{info.port}</dd>
              <dt className="text-[color:var(--workspace-text-subtle)]">{label(t('hostKey.type'))}</dt>
              <dd className="font-mono text-[color:var(--workspace-text)]">{info.keyType}</dd>
              {!oldFingerprint && (
                <>
                  <dt className="text-[color:var(--workspace-text-subtle)]">{label(t('hostKey.fingerprint'))}</dt>
                  <dd data-testid="host-key-fingerprint" className="break-all font-mono text-[color:var(--workspace-text)]">SHA256:{info.fingerprint}</dd>
                </>
              )}
            </dl>

            {oldFingerprint && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-950)] p-3">
                  <div className="text-[11.5px] text-[color:var(--workspace-text-subtle)]">{copy.oldFingerprint}</div>
                  <p data-testid="host-key-old-fingerprint" className="mt-1 break-all font-mono text-xs text-[color:var(--workspace-text-muted)]">SHA256:{oldFingerprint}</p>
                </div>
                <div className="rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[color:var(--workspace-status-bad-bg)] p-3">
                  <div className="text-[11.5px] text-[color:var(--workspace-status-bad-text)]">{copy.newFingerprint}</div>
                  <p data-testid="host-key-fingerprint" className="mt-1 break-all font-mono text-xs text-[color:var(--workspace-text-strong)]">SHA256:{info.fingerprint}</p>
                </div>
              </div>
            )}

            {isMismatch ? (
              <div className="flex gap-2.5 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[color:var(--workspace-status-bad-bg)] p-3">
                <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--workspace-status-bad-text)]" />
                <div className="text-[13px]">
                  <p className="font-semibold text-[color:var(--workspace-text-strong)]">{copy.hostKeyMismatchTitle}</p>
                  <p className="mt-1 text-[color:var(--workspace-text-muted)]">{copy.hostKeyMismatchBody}</p>
                  <p className="mt-1 text-[color:var(--workspace-status-bad-text)]">{t('hostKey.warning')}</p>
                </div>
              </div>
            ) : (
              <p className="flex gap-2 text-xs leading-5 text-[color:var(--workspace-text-subtle)]">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{copy.hostKeyUnknownHint}</span>
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3.5">
            {isMismatch ? (
              <>
                <Button variant="ghost" onClick={() => { onReject(); requestKnownHosts() }} className="gap-1.5">
                  <Shield className="h-4 w-4" />
                  {copy.viewKnownHosts}
                </Button>
                <Button onClick={onReject}>{copy.cancelConnection}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={onReject}>
                  {t('hostKey.cancel')}
                </Button>
                <Button data-testid="host-key-accept" onClick={onAccept} className="gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  {t('hostKey.trustConnect')}
                </Button>
              </>
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
