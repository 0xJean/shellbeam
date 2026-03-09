import { useT } from '@/lib/i18n'
import {
  Monitor,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  RefreshCw,
  Radio,
  Lock,
  AlertTriangle,
} from 'lucide-react'
import type { DiscoveredDevice } from '@/lib/mdns'
import { Button } from '@/components/ui/button'
import { ScanRadar, DeviceCard } from './sync-widgets'

interface ScanningViewProps {
  scanning: boolean
  discoveredDevices: DiscoveredDevice[]
  selectedDevice: DiscoveredDevice | null
  onSelectDevice: (device: DiscoveredDevice) => void
  onRescan: () => void
  onCancel: () => void
}

export function ScanningView({
  scanning, discoveredDevices, selectedDevice,
  onSelectDevice, onRescan, onCancel,
}: ScanningViewProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-12">
      <ScanRadar scanning={scanning} />
      <div className="text-center">
        <h2 className="text-lg font-semibold">
          {scanning ? t('sync.scanningDevices') : t('sync.scanComplete')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('sync.scanHint')}</p>
      </div>
      {discoveredDevices.length > 0 && (
        <div className="w-full space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('sync.devicesFound', { n: discoveredDevices.length })}
          </p>
          {discoveredDevices.map((d) => (
            <DeviceCard
              key={`${d.host}:${d.port}`}
              name={d.name} host={d.host} port={d.port} deviceType={d.deviceType}
              onClick={() => onSelectDevice(d)}
              selected={selectedDevice?.host === d.host && selectedDevice?.port === d.port}
            />
          ))}
        </div>
      )}
      {!scanning && discoveredDevices.length === 0 && (
        <div className="text-center">
          <p className="text-sm text-muted-foreground">{t('sync.noDevices')}</p>
          <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={onRescan}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('sync.retry')}
          </Button>
        </div>
      )}
      <Button variant="ghost" onClick={onCancel} className="text-muted-foreground">
        {t('sync.cancel')}
      </Button>
    </div>
  )
}

interface PairingViewProps {
  selectedDeviceName: string
  pairingError: string
  onCancel: () => void
}

export function PairingView({ selectedDeviceName, pairingError, onCancel }: PairingViewProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-12">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t('sync.initiatingPairing')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('sync.pairingHandshake', { name: selectedDeviceName })}
        </p>
      </div>
      {pairingError && (
        <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
      )}
      <Button variant="ghost" onClick={onCancel} className="text-muted-foreground">
        {t('sync.cancel')}
      </Button>
    </div>
  )
}

interface ConfirmingViewProps {
  selectedDevice: DiscoveredDevice | null
  generatedPin: string
  pairingError: string
  onCancel: () => void
}

export function ConfirmingView({ selectedDevice, generatedPin, pairingError, onCancel }: ConfirmingViewProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
        <CheckCircle2 className="h-8 w-8" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t('sync.pairingRequestSent')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('sync.waitingForPeerAccept')}</p>
      </div>
      {selectedDevice && (
        <div className="flex w-full items-center gap-3 rounded-xl border bg-muted/30 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{selectedDevice.name}</p>
            <p className="text-xs text-muted-foreground">{selectedDevice.host}:{selectedDevice.port}</p>
          </div>
        </div>
      )}
      {generatedPin && (
        <div className="w-full rounded-xl border-2 border-primary/30 bg-primary/5 p-6 text-center">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('sync.verificationCode')}
          </p>
          <p className="font-mono text-3xl font-bold tracking-[0.3em] text-primary">{generatedPin}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('sync.confirmCodeOnPeer')}</p>
        </div>
      )}
      {pairingError && (
        <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
      )}
      <button type="button" onClick={onCancel} className="text-sm text-muted-foreground hover:text-foreground">
        {t('sync.cancel')}
      </button>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
        <Lock className="h-3 w-3" />
        {t('sync.e2eBadge')}
      </div>
    </div>
  )
}

interface IncomingPairViewProps {
  request: {
    sessionId: string
    peerDeviceId: string
    peerDeviceName: string
    peerHost: string
    verificationCode: string
  }
  pairingBusy: boolean
  pairingError: string
  onAccept: () => void
  onCancel: () => void
}

export function IncomingPairView({ request, pairingBusy, pairingError, onAccept, onCancel }: IncomingPairViewProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
        <Radio className="h-8 w-8" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t('sync.incomingPairRequest')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('sync.deviceWantsToPair')}</p>
      </div>
      <div className="flex w-full items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Monitor className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{request.peerDeviceName}</p>
          <p className="font-mono text-xs text-muted-foreground">{request.peerDeviceId.slice(0, 16)}...</p>
        </div>
      </div>
      <div className="w-full rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-6 text-center">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('sync.verificationCode')}
        </p>
        <p className="font-mono text-3xl font-bold tracking-[0.3em] text-amber-500">{request.verificationCode}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('sync.confirmCodeMatches')}</p>
      </div>
      {pairingError && (
        <p className="rounded-lg bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">{pairingError}</p>
      )}
      <div className="flex w-full gap-3">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          {t('sync.reject')}
        </Button>
        <Button className="flex-1 gap-2" disabled={pairingBusy} onClick={onAccept}>
          {pairingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {pairingBusy ? t('sync.confirming') : t('sync.acceptPair')}
        </Button>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
        <Lock className="h-3 w-3" />
        {t('sync.e2eBadge')}
      </div>
    </div>
  )
}

interface ConnectFailedViewProps {
  device: DiscoveredDevice
  onCancel: () => void
}

export function ConnectFailedView({ device, onCancel }: ConnectFailedViewProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-6 pt-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
        <AlertTriangle className="h-8 w-8" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t('sync.cannotConnectTitle')}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('sync.cannotConnectHint')}
        </p>
      </div>
      <div className="flex w-full items-center gap-3 rounded-xl border bg-muted/30 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
          <Monitor className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{device.name}</p>
          <p className="text-xs text-muted-foreground">{device.host}:{device.port}</p>
        </div>
      </div>
      <Button variant="outline" className="w-full" onClick={onCancel}>
        {t('sync.backToHome')}
      </Button>
    </div>
  )
}
