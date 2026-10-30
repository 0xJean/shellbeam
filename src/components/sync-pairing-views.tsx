import { useId, type ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import {
  Monitor,
  Loader2,
  ShieldCheck,
  RefreshCw,
  Radar,
  WifiOff,
  X,
  Smartphone,
} from 'lucide-react'
import type { DiscoveredDevice } from '@/lib/mdns'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fill } from '@/lib/locales/probe-install'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { cn } from '@/lib/utils'
import { ScanRadar, DeviceCard, CodeDigits } from './sync-widgets'

export type PairStep = 'scan' | 'verify' | 'incoming' | 'failed'

function usePairCopy() {
  const { t, locale } = useT()
  return { t, copy: syncBackupCopy[locale] ?? syncBackupCopy['zh-CN'] }
}

export function PairDialog({ open, step, onClose, children }: { open: boolean; step: PairStep; onClose: () => void; children: ReactNode }) {
  const { copy } = usePairCopy()
  const titleId = useId()
  const steps: Array<[PairStep, string]> = [['scan', copy.stepScan], ['verify', copy.stepVerify], ['incoming', copy.stepIncoming], ['failed', copy.stepFailed]]
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }} labelledBy={titleId}>
      <DialogContent className="sb-card md:w-[640px] md:max-w-[640px]">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold text-[var(--workspace-text-strong)]">{copy.addDevice}</h2>
            <p className="mt-0.5 text-[12px] text-[var(--workspace-text-muted)]">{copy.addDeviceSub}</p>
          </div>
          <button type="button" aria-label={copy.close} onClick={onClose} className="rounded-md p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 flex gap-4 overflow-x-auto border-b border-[color:var(--workspace-border-soft)] px-5">
          {steps.map(([id, label]) => (
            <span key={id} aria-current={id === step ? 'step' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 pb-2 text-[13px]', id === step ? 'border-[color:var(--workspace-primary-500)] font-medium text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-subtle)]')}>
              {label}
            </span>
          ))}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">{children}</div>
}

function ErrorLine({ message }: { message: string }) {
  if (!message) return null
  return <p role="alert" className="rounded-lg bg-[var(--workspace-status-bad-bg)] px-4 py-2 text-center text-[12px] text-[color:var(--workspace-status-bad-text)]">{message}</p>
}

function E2eBadge() {
  const { copy } = usePairCopy()
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--workspace-status-good-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--workspace-status-good-text)]">
      <ShieldCheck className="h-3 w-3" />{copy.e2e}
    </span>
  )
}

interface ScanningViewProps {
  scanning: boolean
  discoveredDevices: DiscoveredDevice[]
  selectedDevice: DiscoveredDevice | null
  serverPort?: number
  onSelectDevice: (device: DiscoveredDevice) => void
  onRescan: () => void
  onCancel: () => void
}

export function ScanningView({
  scanning, discoveredDevices, selectedDevice, serverPort,
  onSelectDevice, onRescan, onCancel,
}: ScanningViewProps) {
  const { t, copy } = usePairCopy()
  return (
    <>
      <div className="grid gap-5 p-5 md:grid-cols-[200px_minmax(0,1fr)] md:items-center">
        <ScanRadar scanning={scanning} found={discoveredDevices.length} />
        <div className="overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)]">
          <div className="flex items-baseline gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
            <span className="text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.nearby}</span>
            {serverPort ? <span className="font-mono text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.localService, { port: serverPort })}</span> : null}
          </div>
          {discoveredDevices.length > 0 && (
            <div aria-label={t('sync.devicesFound', { n: discoveredDevices.length })}>
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
            <p className="px-4 pt-3 text-[13px] text-[var(--workspace-text-muted)]">{t('sync.noDevices')}</p>
          )}
          <p className="flex items-center gap-1.5 px-4 py-2.5 text-[11px] text-[var(--workspace-text-subtle)]">
            {scanning ? <Radar className="h-3.5 w-3.5 animate-pulse" /> : <Radar className="h-3.5 w-3.5" />}
            {scanning ? copy.scanningHint : `${copy.scanDone} · ${t('sync.scanHint')}`}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onRescan}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t('sync.retry')}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>{t('sync.cancel')}</Button>
      </div>
    </>
  )
}

interface PairingViewProps {
  selectedDeviceName: string
  pairingError: string
  onCancel: () => void
}

export function PairingView({ selectedDeviceName, pairingError, onCancel }: PairingViewProps) {
  const { t, copy } = usePairCopy()
  return (
    <>
      <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <E2eBadge />
        <h3 className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{t('sync.initiatingPairing')}</h3>
        <p className="flex items-center gap-1.5 text-[12px] text-[var(--workspace-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {fill(copy.connecting, { name: selectedDeviceName })}
        </p>
        <ErrorLine message={pairingError} />
      </div>
      <Footer><Button variant="outline" size="sm" onClick={onCancel}>{t('sync.cancel')}</Button></Footer>
    </>
  )
}

interface ConfirmingViewProps {
  selectedDevice: DiscoveredDevice | null
  generatedPin: string
  pairingError: string
  onCancel: () => void
}

export function ConfirmingView({ selectedDevice, generatedPin, pairingError, onCancel }: ConfirmingViewProps) {
  const { t, copy } = usePairCopy()
  const name = selectedDevice?.name ?? t('sync.unknown')
  return (
    <>
      <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
        <E2eBadge />
        <h3 className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{copy.verifyTitle}</h3>
        <p className="max-w-md text-[12px] leading-relaxed text-[var(--workspace-text-muted)]">{fill(copy.verifyDesc, { name })}</p>
        {generatedPin && <CodeDigits code={generatedPin} label={t('sync.verificationCode')} />}
        <p className="flex items-center gap-1.5 text-[12px] text-[var(--workspace-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {fill(copy.waitingAccept, { name })}
        </p>
        {selectedDevice && <p className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{selectedDevice.host}:{selectedDevice.port}</p>}
        <ErrorLine message={pairingError} />
      </div>
      <Footer><Button variant="outline" size="sm" onClick={onCancel}>{t('sync.cancel')}</Button></Footer>
    </>
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
  const { t, copy } = usePairCopy()
  return (
    <>
      <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
          <Smartphone className="h-5 w-5" />
        </div>
        <h3 className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{fill(copy.incomingTitle, { name: request.peerDeviceName })}</h3>
        <p className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{request.peerDeviceId.slice(0, 16)}...</p>
        <p className="max-w-md text-[12px] text-[var(--workspace-text-muted)]">{copy.incomingDesc}</p>
        <CodeDigits code={request.verificationCode} label={t('sync.verificationCode')} />
        <ErrorLine message={pairingError} />
      </div>
      <Footer>
        <Button variant="outline" size="sm" onClick={onCancel}>{t('sync.reject')}</Button>
        <Button size="sm" className="gap-1.5" disabled={pairingBusy} onClick={onAccept}>
          {pairingBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {pairingBusy ? t('sync.confirming') : t('sync.acceptPair')}
        </Button>
      </Footer>
    </>
  )
}

interface ConnectFailedViewProps {
  device: DiscoveredDevice
  onCancel: () => void
  onRescan?: () => void
}

export function ConnectFailedView({ device, onCancel, onRescan }: ConnectFailedViewProps) {
  const { t } = usePairCopy()
  return (
    <>
      <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]">
          <WifiOff className="h-5 w-5" />
        </div>
        <h3 className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{t('sync.cannotConnectTitle')}</h3>
        <p className="max-w-md text-[12px] leading-relaxed text-[var(--workspace-text-muted)]">{t('sync.cannotConnectHint')}</p>
        <p className="flex items-center gap-1.5 text-[12px] text-[var(--workspace-text-muted)]">
          <Monitor className="h-3.5 w-3.5" />
          {device.name} · <span className="font-mono">{device.host}:{device.port}</span>
        </p>
      </div>
      <Footer>
        <Button variant="outline" size="sm" onClick={onCancel}>{onRescan ? t('sync.cancel') : t('sync.backToHome')}</Button>
        {onRescan && (
          <Button size="sm" className="gap-1.5" onClick={onRescan}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('sync.retry')}
          </Button>
        )}
      </Footer>
    </>
  )
}
