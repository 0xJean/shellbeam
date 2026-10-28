import { useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Smartphone,
  Loader2,
  ArrowUpFromLine,
  ArrowDownToLine,
  WifiOff,
  Unlink,
  Radar,
  Info,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react'
import type { SyncTrustedPeer, SyncDataOptions } from '@/lib/sync'
import { Button } from '@/components/ui/button'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { syncVaultCopy } from '@/lib/locales/sync-vault'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import { Switch } from './sync-widgets'

const SYNC_DATA_ITEMS = [
  { key: 'includeHosts', label: 'backup.hosts', desc: 'hostsDesc' },
  { key: 'includeSnippets', label: 'backup.snippetsData', desc: 'snippetsDesc' },
  { key: 'includeVault', label: 'backup.vaultData', desc: 'vaultDesc' },
] as const

interface SyncPeerDetailProps {
  peer: SyncTrustedPeer
  peerOnline: boolean
  loading: boolean
  onBack: () => void
  onScan?: () => void
  onPullFromPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onPushToPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onRemoveTrustedPeer: (peerDeviceId: string) => Promise<void>
  /** Active vault that pull/push sync; the line is hidden when unknown. */
  vaultName?: string
}

export function SyncPeerDetail({
  peer, peerOnline, loading,
  onBack, onScan, onPullFromPeer, onPushToPeer, onRemoveTrustedPeer, vaultName,
}: SyncPeerDetailProps) {
  const { t, locale } = useT()
  const copy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const vaultCopy = syncVaultCopy[locale] ?? syncVaultCopy['zh-CN']
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [syncDataOpts, setSyncDataOpts] = useState<SyncDataOptions>({
    includeHosts: true, includeSnippets: true, includeVault: false,
  })
  const anySyncDataSelected = syncDataOpts.includeHosts || syncDataOpts.includeSnippets || syncDataOpts.includeVault

  async function run(action: typeof onPushToPeer, success: string) {
    setSyncResult(null)
    try {
      await action(peer.peerDeviceId, syncDataOpts)
      setSyncResult({ ok: true, message: success })
    } catch (err) {
      setSyncResult({ ok: false, message: String(err) })
    }
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <section className="sb-card overflow-hidden">
        <div className="flex items-center gap-4 border-b border-[color:var(--workspace-border-soft)] p-5">
          <div className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded-xl', peerOnline ? 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
            <Smartphone className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[18px] font-semibold text-[var(--workspace-text-strong)]">{peer.peerDeviceName ?? t('sync.unknown')}</p>
              <span className={cn('flex items-center gap-1 text-[12px]', peerOnline ? 'text-[color:var(--workspace-status-good-text)]' : 'text-[var(--workspace-text-subtle)]')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', peerOnline ? 'bg-[color:var(--workspace-status-good)]' : 'bg-[var(--workspace-text-subtle)]')} />
                {peerOnline ? t('sync.online') : t('sync.offline')}
              </span>
            </div>
            <p className="truncate font-mono text-[12px] text-[var(--workspace-text-muted)]">
              {peer.peerEndpoint ?? t('sync.noEndpoint')}
              {' · '}
              {t('sync.lastSeen')}: {new Date(peer.lastSeenAt).toLocaleString()}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
            disabled={loading}
            onClick={async () => {
              await onRemoveTrustedPeer(peer.peerDeviceId)
              onBack()
            }}
          >
            <Unlink className="h-3.5 w-3.5" />
            {t('sync.removePeer')}
          </Button>
        </div>

        <div className="border-b border-[color:var(--workspace-border-soft)] px-5 py-3 text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.dataTypes}</div>
        {SYNC_DATA_ITEMS.map((item) => {
          const checked = Boolean(syncDataOpts[item.key])
          return (
            <div key={item.key} className="flex items-center gap-3 border-b border-[color:var(--workspace-border-soft)] px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--workspace-text-strong)]">{t(item.label)}</p>
                <p className="text-[12px] text-[var(--workspace-text-muted)]">{copy[item.desc]}</p>
              </div>
              <Switch
                checked={checked}
                disabled={loading}
                label={t(item.label)}
                onChange={(value) => setSyncDataOpts((prev) => ({ ...prev, [item.key]: value }))}
              />
            </div>
          )
        })}

        <div className="space-y-3 p-5">
          {syncDataOpts.includeVault && (
            <p className="text-[12px] text-[color:var(--workspace-status-warn-text)]">{t('sync.vaultSyncHint')}</p>
          )}
          {vaultName && (
            <p className="text-[12px] text-[var(--workspace-text-muted)]">{fill(vaultCopy.syncingVault, { name: vaultName })}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={loading || !peer.peerEndpoint || !anySyncDataSelected}
              onClick={() => void run(onPushToPeer, t('sync.syncSuccess'))}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
              {t('sync.syncToPeer')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={loading || !peer.peerEndpoint || !anySyncDataSelected}
              onClick={() => void run(onPullFromPeer, t('sync.pullSuccess'))}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
              {t('sync.pullFromPeer')}
            </Button>
          </div>

          {syncResult && (
            <p className={cn('flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px]', syncResult.ok ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]')}>
              {syncResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              {syncResult.message}
            </p>
          )}

          {!peer.peerEndpoint && (
            <p className="text-[12px] text-[var(--workspace-text-muted)]">{t('sync.noEndpointHint')}</p>
          )}
        </div>
      </section>

      <div className="space-y-4">
        {!peerOnline && (
          <section className="sb-card overflow-hidden">
            <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-3 text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.offlineTitle}</div>
            <p className="flex items-start gap-2 px-4 py-3 text-[12px] leading-relaxed text-[color:var(--workspace-status-warn-text)]">
              <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('sync.peerOfflineHint')}
            </p>
          </section>
        )}
        {onScan && (
          <section className="sb-card overflow-hidden">
            <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-3 text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.addMore}</div>
            <div className="space-y-3 p-4">
              <p className="flex items-start gap-2 text-[12px] text-[var(--workspace-text-muted)]">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {copy.addMoreHint}
              </p>
              <Button variant="outline" size="sm" className="w-full gap-1.5" disabled={loading} onClick={onScan}>
                <Radar className="h-3.5 w-3.5" />
                {copy.scanNearby}
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
