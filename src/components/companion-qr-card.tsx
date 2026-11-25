import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Check, ChevronDown, Copy, Link2, Loader2, Play, QrCode, Radio, ScanLine, Smartphone } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import {
  buildPairingQrPayload,
  COMPANION_OPEN_SCANNER_EVENT,
  companionLocalEndpoints,
  companionServerStatus,
  companionSetServerEnabled,
  consumePendingMobileQrScan,
  formatCompanionError,
  parsePairingQrPayload,
  type ParsedPairingLink,
} from '@/lib/companion'
import type { PeerRoute } from '@/lib/sync'
import { copyTextToClipboard } from '@/lib/clipboard'
import { isMobileDevice } from '@/lib/mobile-back'
import { QrScannerModal } from '@/components/mobile/qr-scanner-modal'
import { Button } from '@/components/ui/button'
import { Switch } from './sync-widgets'
import { cn } from '@/lib/utils'

interface CompanionQrCardProps {
  deviceName?: string
  serverRunning: boolean
  serverPort: number
  onStartServer?: () => Promise<void>
  onDirectPair: (parsed: ParsedPairingLink) => Promise<void>
}

export function CompanionQrCard({
  deviceName,
  serverRunning,
  serverPort,
  onStartServer,
  onDirectPair,
}: CompanionQrCardProps) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const mobile = isMobileDevice()
  const [routes, setRoutes] = useState<PeerRoute[]>([])
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [bridgeEnabled, setBridgeEnabled] = useState(true)
  const [expanded, setExpanded] = useState(mobile)
  const [panelTab, setPanelTab] = useState<'qr' | 'link'>(mobile ? 'link' : 'qr')
  const [startingServer, setStartingServer] = useState(false)
  const [directInput, setDirectInput] = useState('')
  const [directBusy, setDirectBusy] = useState(false)
  const [directError, setDirectError] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)

  useEffect(() => {
    if (!mobile) return
    if (consumePendingMobileQrScan()) {
      setExpanded(true)
      setScannerOpen(true)
    }
    const onOpenScanner = () => {
      consumePendingMobileQrScan()
      setExpanded(true)
      setScannerOpen(true)
    }
    window.addEventListener(COMPANION_OPEN_SCANNER_EVENT, onOpenScanner)
    return () => window.removeEventListener(COMPANION_OPEN_SCANNER_EVENT, onOpenScanner)
  }, [mobile])

  useEffect(() => {
    let active = true
    void companionLocalEndpoints().then((list) => {
      if (active) setRoutes(list)
    })
    void companionServerStatus().then((st) => {
      if (active) setBridgeEnabled(st.enabled)
    })
    return () => { active = false }
  }, [serverRunning, serverPort])

  const pairPayload = useMemo(
    () => buildPairingQrPayload({ routes, port: serverPort || 9123, deviceName }),
    [routes, serverPort, deviceName],
  )

  useEffect(() => {
    if (mobile || routes.length === 0) {
      setQrDataUrl('')
      return
    }
    let active = true
    void QRCode.toDataURL(pairPayload, {
      margin: 2,
      width: 280,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => { if (active) setQrDataUrl(url) })
      .catch(() => { if (active) setQrDataUrl('') })
    return () => { active = false }
  }, [mobile, pairPayload, routes.length])

  const routeLabel = (kind: string) => (
    kind === 'tailnet' ? copy.routeTailnet : kind === 'lan' ? copy.routeLan : copy.routeCustom
  )

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(pairPayload)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }
  }

  const handleToggleBridge = async (next: boolean) => {
    setBridgeEnabled(next)
    try {
      const actual = await companionSetServerEnabled(next)
      setBridgeEnabled(actual)
    } catch {
      setBridgeEnabled(!next)
    }
  }

  const handleStartServer = async () => {
    if (!onStartServer) return
    setStartingServer(true)
    try {
      await onStartServer()
    } finally {
      setStartingServer(false)
    }
  }

  const handleDirectSubmit = async () => {
    setDirectError('')
    const parsed = parsePairingQrPayload(directInput)
    if (!parsed) {
      setDirectError(copy.directConnectHint)
      return
    }
    setDirectBusy(true)
    try {
      await onDirectPair(parsed)
      setDirectInput('')
    } catch (err) {
      setDirectError(formatCompanionError(err, locale))
    } finally {
      setDirectBusy(false)
    }
  }

  const handleScannedQr = async (_raw: string, parsed: ParsedPairingLink) => {
    setScannerOpen(false)
    setDirectError('')
    setDirectBusy(true)
    try {
      await onDirectPair(parsed)
    } catch (err) {
      setDirectError(formatCompanionError(err, locale))
    } finally {
      setDirectBusy(false)
    }
  }

  return (
    <div className="border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/35 px-5 py-3">
      {/* Compact top bar: bridge toggle + detected routes summary + QR/Direct expand trigger */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Smartphone className="h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" />
          <span className="text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.title}</span>
          {!mobile && routes.slice(0, 2).map((r) => (
            <span
              key={`${r.kind}:${r.host}:${r.port}`}
              className={cn(
                'hidden items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] sm:inline-flex',
                r.kind === 'tailnet'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
              )}
            >
              <span className="font-sans font-medium">{routeLabel(r.kind)}</span>
              <span>{r.host}</span>
            </span>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {!mobile && (
            <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-muted)]">
              <span>{copy.remoteBridgeToggleShort}</span>
              <Switch
                checked={bridgeEnabled}
                label={copy.remoteBridgeEnabled}
                onChange={(v) => void handleToggleBridge(v)}
              />
            </label>
          )}
          <Button
            size="sm"
            variant={expanded ? 'secondary' : 'outline'}
            className="h-7 gap-1.5 px-2.5 text-[11.5px]"
            onClick={() => setExpanded((v) => !v)}
          >
            <QrCode className="h-3.5 w-3.5" />
            <span>{expanded ? copy.hideQrAction : copy.showQrAction}</span>
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>
      </div>

      {/* Expandable QR / Direct Link pairing drawer */}
      {expanded && (
        <div className="mt-3 space-y-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]/80 p-3.5">
          {!mobile && (
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-lg bg-[var(--workspace-surface-900)] p-0.5 text-[11.5px]">
                <button
                  type="button"
                  onClick={() => setPanelTab('qr')}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                    panelTab === 'qr'
                      ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm'
                      : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                  )}
                >
                  <QrCode className="h-3.5 w-3.5" />
                  {copy.qrPairTab}
                </button>
                <button
                  type="button"
                  onClick={() => setPanelTab('link')}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                    panelTab === 'link'
                      ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm'
                      : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                  )}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {copy.linkPairTab}
                </button>
              </div>
              {!serverRunning && onStartServer && (
                <Button
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-[11.5px]"
                  disabled={startingServer}
                  onClick={() => void handleStartServer()}
                >
                  {startingServer ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  {copy.startServerAction}
                </Button>
              )}
            </div>
          )}

          {!mobile && panelTab === 'qr' ? (
            <div className="space-y-2.5">
              {!serverRunning && (
                <p className="rounded-lg bg-[var(--workspace-status-warn-bg)] px-3 py-2 text-[11.5px] text-[color:var(--workspace-status-warn-text)]">
                  {copy.startServerHint}
                </p>
              )}
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                {qrDataUrl && (
                  <div
                    data-testid="companion-qr-code"
                    className="shrink-0 rounded-xl bg-white p-2 shadow-sm"
                  >
                    <img
                      src={qrDataUrl}
                      alt={copy.qrPairTitle}
                      className="block h-[132px] w-[132px]"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="text-[11.5px] leading-relaxed text-[var(--workspace-text-muted)]">
                    {copy.qrPairDesc}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {routes.map((r) => (
                      <span
                        key={`${r.kind}:${r.host}:${r.port}`}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px]',
                          r.kind === 'tailnet'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
                        )}
                      >
                        <Radio className="h-3 w-3" />
                        <span className="font-sans font-medium">{routeLabel(r.kind)}</span>
                        <span>{r.host}:{r.port}</span>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" title={pairPayload}>
                      {pairPayload}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 gap-1 px-2 text-[11px] text-[color:var(--workspace-accent-text)]"
                      onClick={() => void handleCopy()}
                    >
                      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copied ? copy.copied : copy.copyPairLink}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {mobile && (
                <Button
                  size="sm"
                  className="h-9 w-full gap-2 text-[13px] font-medium"
                  disabled={directBusy}
                  onClick={() => setScannerOpen(true)}
                >
                  <ScanLine className="h-4 w-4" />
                  {copy.scanQrAction}
                </Button>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={directInput}
                  onChange={(e) => { setDirectInput(e.target.value); setDirectError('') }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !directBusy && directInput.trim()) void handleDirectSubmit() }}
                  placeholder={copy.directConnectPlaceholder}
                  aria-label={copy.directConnectTitle}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 font-mono text-[12px] text-[var(--workspace-text-strong)] outline-none placeholder:font-sans placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]"
                />
                <Button
                  size="sm"
                  variant={mobile ? 'outline' : 'default'}
                  className="h-8 shrink-0 gap-1.5 px-3 text-[12px]"
                  disabled={directBusy || !directInput.trim()}
                  onClick={() => void handleDirectSubmit()}
                >
                  {directBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {copy.directConnectAction}
                </Button>
              </div>
              {directError
                ? <p className="text-[11px] text-[color:var(--workspace-status-bad-text)]">{directError}</p>
                : <p className="text-[11px] text-[var(--workspace-text-subtle)]">{copy.directConnectHint}</p>}
            </div>
          )}
        </div>
      )}

      {mobile && (
        <QrScannerModal
          open={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onDetected={(raw, parsed) => void handleScannedQr(raw, parsed)}
        />
      )}
    </div>
  )
}
