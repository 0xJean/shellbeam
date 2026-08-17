import { useMemo } from 'react'
import { AlertCircle, CheckCircle2, Loader2, MonitorCog, Server, ShieldCheck, Sparkles, TerminalSquare, X } from 'lucide-react'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import { HostMetadataLine } from './host-display-meta'

interface SessionConnectPlaceholderProps {
  hostName: string
  hostAddress: string
  connectionKind?: 'host' | 'local'
  status: 'connecting' | 'error'
  stage?: string
  errorMessage?: string
  network?: HostNetworkDisplay
  resource?: Pick<WorkspaceInventoryResource, 'os'>
  onRetry?: () => void
  onCancel?: () => void
}

function generateSessionId(hostName: string): string {
  let hash = 0
  const str = hostName + Date.now().toString(36)
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')
  return `X${hex.slice(0, 3)}-${hex.slice(3, 6)}-${hex.slice(6, 8)}${String.fromCharCode(65 + (Math.abs(hash) % 26))}${String.fromCharCode(65 + ((Math.abs(hash) >> 4) % 26))}${Math.abs(hash % 100).toString().padStart(2, '0')}`
}

export function SessionConnectPlaceholder({
  hostName,
  hostAddress,
  connectionKind,
  status,
  stage,
  errorMessage,
  network,
  resource,
  onRetry,
  onCancel,
}: SessionConnectPlaceholderProps) {
  const { t } = useT()
  const isLocal = connectionKind === 'local' || hostAddress === 'local'

  const steps = isLocal
    ? [
        { icon: MonitorCog, stage: 'detect_shell', label: t('terminalConnect.detectShell') },
        { icon: MonitorCog, stage: 'spawn_shell', label: t('terminalConnect.spawnShell') },
        { icon: TerminalSquare, stage: 'allocate_pty', label: t('terminalConnect.allocatePty') },
        { icon: Sparkles, stage: 'prepare_workspace', label: t('terminalConnect.prepareWorkspace') },
      ]
    : [
        { icon: Server, stage: 'resolve_host', label: t('terminalConnect.resolveHost') },
        { icon: Server, stage: 'open_tcp', label: t('terminalConnect.openTcp') },
        { icon: ShieldCheck, stage: 'verify_host', label: t('terminalConnect.verifyHost') },
        { icon: ShieldCheck, stage: 'secure_session', label: t('terminalConnect.secureSession') },
        { icon: ShieldCheck, stage: 'authenticate', label: t('terminalConnect.authenticate') },
        { icon: TerminalSquare, stage: 'prepare_workspace', label: t('terminalConnect.prepareWorkspace') },
      ]

  const currentIndex = Math.max(steps.findIndex((item) => item.stage === stage), 0)
  const sessionId = useMemo(() => generateSessionId(hostName || hostAddress), [hostName, hostAddress])
  const latency = useMemo(() => Math.floor(Math.random() * 18) + 8, [])

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10">
        <div className="w-full max-w-2xl">
          <div className="rounded-[28px] border border-border/70 bg-card px-6 py-7 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertCircle className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  {t('terminalConnect.failedEyebrow')}
                </div>
                <h2 className="mt-2 text-xl font-semibold text-foreground">
                  {t('terminalConnect.failedTitle', { host: hostName || hostAddress })}
                </h2>
              </div>
            </div>

            <div className="mt-6 rounded-[24px] border border-border/60 bg-background px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {t('terminalConnect.failureDetails')}
                </div>
                <div className="rounded-full border border-destructive/20 bg-destructive/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-destructive">
                  {t('terminalConnect.failedStatus')}
                </div>
              </div>
              <div className="mt-3 break-words text-sm leading-6 text-foreground">
                {errorMessage || t('terminalConnect.failedFallback')}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>{hostName || hostAddress}</span>
                <span className="h-1 w-1 rounded-full bg-border" />
                <span>{hostAddress}</span>
                <span className="h-1 w-1 rounded-full bg-border" />
                <span>{isLocal ? t('terminalConnect.localShellTag') : t('terminalConnect.remoteSessionTag')}</span>
              </div>
              {!isLocal && (
                <HostMetadataLine
                  network={network}
                  resource={resource}
                  regionLabel={hostAddress}
                  className="mt-3 text-xs text-muted-foreground"
                  itemClassName="max-w-[10rem]"
                  iconClassName="h-3.5 w-3.5"
                />
              )}
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              {t('terminalConnect.failedHint')}
            </p>

            {onRetry && (
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Sparkles className="h-4 w-4" />
                  {t('terminalConnect.retry')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col items-center overflow-hidden">
      {/* ── Inline keyframes ── */}
      <style>{`
        @keyframes scp-glow-pulse { 0%,100%{opacity:.45} 50%{opacity:.85} }
        @keyframes scp-border-spin { to{transform:rotate(360deg)} }
        @keyframes scp-scan-line { 0%{top:0;opacity:.6} 100%{top:100%;opacity:0} }
      `}</style>

      {/* ── Main content (scrollable, centered) ── */}
      <div className="flex w-full max-w-[680px] flex-1 flex-col items-center px-6 pb-24 pt-12">

        {/* ── Header ── */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1e3a5f] bg-[#0d1b2a]/80 text-[#3b82f6]">
            <TerminalSquare className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
            {(hostName || hostAddress).toUpperCase()}
          </h1>
        </div>
        <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[#64748b]">
          {isLocal ? 'LOCAL SESSION' : `CONNECTING TO: ${hostAddress}`}
        </div>
        {!isLocal && (
          <HostMetadataLine
            network={network}
            resource={resource}
            regionLabel={hostAddress}
            className="mt-3 justify-center text-xs text-[#64748b]"
            itemClassName="max-w-[10rem]"
            iconClassName="h-3.5 w-3.5"
          />
        )}

        {/* ── 3D Encryption Card ── */}
        <div className="relative mt-10 flex flex-col items-center">
          {/* RSA label */}
          <div className="mb-3 rounded border border-[#1e3a5f] bg-[#0d1b2a] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#3b82f6]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            RSA_4096
          </div>

          {/* Perspective container */}
          <div className="relative" style={{ perspective: '800px' }}>
            <div
              className="relative h-[260px] w-[320px] overflow-hidden rounded-xl border border-[#1e3a5f]/80 bg-[#0a1628]"
              style={{ transform: 'rotateX(4deg) rotateY(-2deg)', transformStyle: 'preserve-3d' }}
            >
              {/* Animated glow border */}
              <div className="pointer-events-none absolute inset-0 rounded-xl" style={{
                background: 'linear-gradient(135deg, rgba(59,130,246,.35) 0%, transparent 40%, transparent 60%, rgba(59,130,246,.15) 100%)',
                animation: 'scp-glow-pulse 3s ease-in-out infinite',
              }} />

              {/* Corner accents */}
              <div className="absolute left-0 top-0 h-16 w-[1px] bg-gradient-to-b from-[#3b82f6]/60 to-transparent" />
              <div className="absolute left-0 top-0 h-[1px] w-16 bg-gradient-to-r from-[#3b82f6]/60 to-transparent" />
              <div className="absolute bottom-0 right-0 h-16 w-[1px] bg-gradient-to-t from-[#3b82f6]/30 to-transparent" />
              <div className="absolute bottom-0 right-0 h-[1px] w-16 bg-gradient-to-l from-[#3b82f6]/30 to-transparent" />

              {/* Inner card */}
              <div className="absolute inset-6 flex flex-col items-center justify-center rounded-lg border border-[#1e3a5f]/50 bg-[#111b2e]">
                {/* Scanning line */}
                <div className="pointer-events-none absolute left-0 h-[1px] w-full bg-[#3b82f6]/20" style={{ animation: 'scp-scan-line 2.5s ease-in-out infinite' }} />

                {/* Terminal icon */}
                <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-[#1e3a5f] bg-[#0d1b2a] text-[#3b82f6]">
                  <TerminalSquare className="h-8 w-8" />
                </div>
                <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.3em] text-[#3b82f6]/70" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  ENCRYPTING
                </div>
              </div>

              {/* Spinning border arc */}
              <div className="pointer-events-none absolute inset-0">
                <svg className="h-full w-full" viewBox="0 0 320 260">
                  <defs>
                    <linearGradient id="scp-arc-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <rect x="2" y="2" width="316" height="256" rx="12" fill="none" stroke="url(#scp-arc-grad)" strokeWidth="1.5" strokeDasharray="120 500" style={{ animation: 'scp-border-spin 4s linear infinite', transformOrigin: 'center' }} />
                </svg>
              </div>
            </div>
          </div>

          {/* AES label */}
          <div className="mt-3 rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#64748b]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            AES_256_GCM
          </div>
        </div>

        {/* ── Connection Protocol Panel ── */}
        <div className="mt-10 w-full max-w-[480px] rounded-xl border border-[#1e3a5f]/50 bg-[#0d1b2a]/60 px-5 py-5 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#64748b]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              CONNECTION PROTOCOL
            </div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-[#3b82f6] opacity-60" />
                <span className="relative h-2 w-2 rounded-full bg-[#3b82f6]" />
              </span>
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#3b82f6]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                HANDSHAKE_ACTIVE
              </span>
            </div>
          </div>

          <div className="mt-5 space-y-1">
            {steps.map((item, index) => {
              const done = index < currentIndex
              const current = index === currentIndex

              return (
                <div key={item.stage} className="flex items-center gap-3 py-2">
                  {/* Step number */}
                  <span className={cn(
                    'w-6 text-right text-[12px] font-bold tabular-nums',
                    current ? 'text-[#3b82f6]' : done ? 'text-[#3b82f6]/60' : 'text-[#1e3a5f]',
                  )} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>

                  {/* Status icon */}
                  <div className="flex h-5 w-5 items-center justify-center">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : current ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#3b82f6]" />
                    ) : (
                      <div className="h-3 w-3 rounded-full border border-[#1e3a5f]/60" />
                    )}
                  </div>

                  {/* Label */}
                  <span className={cn(
                    'text-sm',
                    current ? 'font-semibold text-white' : done ? 'text-[#94a3b8]' : 'text-[#334155]',
                  )} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                    {item.label}{current ? '...' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Cancel button ── */}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-8 inline-flex items-center gap-2 rounded-lg border border-[#1e3a5f]/50 bg-[#0d1b2a]/60 px-6 py-2.5 text-[11px] font-bold uppercase tracking-[0.22em] text-[#64748b] transition-colors hover:border-[#1e3a5f] hover:text-[#94a3b8]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <X className="h-3.5 w-3.5" />
            CANCEL CONNECTION
          </button>
        )}
      </div>

      {/* ── Bottom status bar (fixed) ── */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-[#1e3a5f]/30 bg-[#060d1b]/90 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#475569]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>SESSION ID</div>
            <div className="mt-0.5 text-[11px] font-medium text-[#94a3b8]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{sessionId}</div>
          </div>
          <div className="h-6 w-[1px] bg-[#1e3a5f]/40" />
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#475569]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>LATENCY</div>
            <div className="mt-0.5 text-[11px] font-bold text-emerald-500" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{latency}ms</div>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-[#1e3a5f]/40 bg-[#0d1b2a]/60 px-3 py-1.5">
          <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#64748b]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>SYSTEM HEALTH</span>
          <div className="flex items-end gap-[3px]">
            <div className="h-3 w-[3px] rounded-sm bg-[#3b82f6]" />
            <div className="h-4 w-[3px] rounded-sm bg-[#3b82f6]" />
            <div className="h-2.5 w-[3px] rounded-sm bg-[#3b82f6]" />
          </div>
        </div>
      </div>
    </div>
  )
}
