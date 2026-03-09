import { useState } from 'react'
import { useT } from '@/lib/i18n'
import {
  Monitor,
  Loader2,
  ArrowUpFromLine,
  ArrowDownToLine,
  Radio,
  ArrowLeft,
  Trash2,
  Server,
  Code2,
  KeyRound,
  Check,
} from 'lucide-react'
import type { SyncTrustedPeer, SyncDataOptions } from '@/lib/sync'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const SYNC_DATA_ITEMS = [
  { key: 'includeHosts', label: 'backup.hosts', icon: Server },
  { key: 'includeSnippets', label: 'backup.snippetsData', icon: Code2 },
  { key: 'includeVault', label: 'backup.vaultData', icon: KeyRound },
] as const

interface SyncPeerDetailProps {
  peer: SyncTrustedPeer
  peerOnline: boolean
  loading: boolean
  onBack: () => void
  onPullFromPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onPushToPeer: (peerDeviceId: string, options?: SyncDataOptions) => Promise<void>
  onRemoveTrustedPeer: (peerDeviceId: string) => Promise<void>
}

export function SyncPeerDetail({
  peer, peerOnline, loading,
  onBack, onPullFromPeer, onPushToPeer, onRemoveTrustedPeer,
}: SyncPeerDetailProps) {
  const { t } = useT()
  const [syncResult, setSyncResult] = useState('')
  const [syncDataOpts, setSyncDataOpts] = useState<SyncDataOptions>({
    includeHosts: true, includeSnippets: true, includeVault: false,
  })
  const anySyncDataSelected = syncDataOpts.includeHosts || syncDataOpts.includeSnippets || syncDataOpts.includeVault

  return (
    <div className="mx-auto max-w-md space-y-6 p-6 pt-8">
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" />
        {t('sync.backToHome')}
      </button>

      {/* Peer info card */}
      <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <div className={cn('flex h-12 w-12 items-center justify-center rounded-lg', peerOnline ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground')}>
          <Monitor className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium">{peer.peerDeviceName ?? t('sync.unknown')}</p>
            {peerOnline ? (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('sync.online')}
              </span>
            ) : (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                {t('sync.offline')}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {peer.peerEndpoint ?? t('sync.noEndpoint')}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {t('sync.lastSeen')}: {new Date(peer.lastSeenAt).toLocaleString()}
          </p>
        </div>
      </div>

      {!peerOnline && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-4 py-3">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('sync.peerOfflineHint')}
          </p>
        </div>
      )}

      {/* Data type selection */}
      <div className="space-y-2">
        <span className="text-sm font-medium">{t('sync.dataToSync')}</span>
        <div className="grid grid-cols-3 gap-2">
          {SYNC_DATA_ITEMS.map((item) => {
            const Icon = item.icon
            const checked = syncDataOpts[item.key as keyof typeof syncDataOpts]
            return (
              <button
                key={item.key}
                type="button"
                disabled={loading}
                onClick={() => setSyncDataOpts(prev => ({ ...prev, [item.key]: !prev[item.key as keyof typeof prev] }))}
                className={cn(
                  'flex items-center gap-2 rounded-lg border p-2.5 text-left transition-all',
                  checked
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
                  loading && 'opacity-50 pointer-events-none',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} />
                <span className="flex-1 text-xs font-medium">{t(item.label)}</span>
                <div className={cn(
                  'h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors',
                  checked ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                )}>
                  {checked && <Check className="h-2 w-2 text-white" />}
                </div>
              </button>
            )
          })}
        </div>
        {syncDataOpts.includeVault && (
          <p className="text-[11px] text-amber-500">{t('sync.vaultSyncHint')}</p>
        )}
      </div>

      {/* Sync (push) button */}
      <Button
        className="w-full gap-2"
        size="lg"
        disabled={loading || !peer.peerEndpoint || !anySyncDataSelected}
        onClick={async () => {
          setSyncResult('')
          try {
            await onPushToPeer(peer.peerDeviceId, syncDataOpts)
            setSyncResult(t('sync.syncSuccess'))
          } catch (err) {
            setSyncResult(String(err))
          }
        }}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        {t('sync.syncToPeer')}
      </Button>

      {/* Pull from peer button */}
      <Button
        variant="outline"
        className="w-full gap-2"
        size="lg"
        disabled={loading || !peer.peerEndpoint || !anySyncDataSelected}
        onClick={async () => {
          setSyncResult('')
          try {
            await onPullFromPeer(peer.peerDeviceId, syncDataOpts)
            setSyncResult(t('sync.pullSuccess'))
          } catch (err) {
            setSyncResult(String(err))
          }
        }}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
        {t('sync.pullFromPeer')}
      </Button>

      {/* Sync result feedback */}
      {syncResult && (
        <p className="rounded-lg bg-muted/50 px-4 py-2 text-center text-sm">{syncResult}</p>
      )}

      {!peer.peerEndpoint && (
        <p className="text-center text-xs text-muted-foreground">{t('sync.noEndpointHint')}</p>
      )}
      {peer.peerEndpoint && !peerOnline && (
        <p className="text-center text-xs text-muted-foreground">{t('sync.peerOfflineHint')}</p>
      )}

      {/* Remove peer */}
      <div className="border-t pt-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-full gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={loading}
          onClick={async () => {
            await onRemoveTrustedPeer(peer.peerDeviceId)
            onBack()
          }}
        >
          <Trash2 className="h-4 w-4" />
          {t('sync.removePeer')}
        </Button>
      </div>
    </div>
  )
}
