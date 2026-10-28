import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Info, Loader2, PlugZap, RotateCw, Shield, TerminalSquare, X } from 'lucide-react'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { parseConnectFailure, type RemoteConnectStage } from '@/lib/connection-failure'
import { useT } from '@/lib/i18n'
import { connectionStatesCopy } from '@/lib/locales/connection-states'
import { requestKnownHosts } from '@/lib/navigation-request'
import { cn } from '@/lib/utils'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import { HostMetadataLine } from './host-display-meta'
import { Button } from './ui/button'

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

type StepState = 'done' | 'current' | 'failed' | 'pending'

function StageRow({ index, label, state, note }: { index: number; label: string; state: StepState; note?: string }) {
  return (
    <li className="flex items-start gap-3" data-stage-state={state}>
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
          state === 'done' && 'bg-[color:var(--workspace-status-good)] text-white',
          state === 'failed' && 'bg-[color:var(--workspace-status-bad)] text-white',
          state === 'current' && 'border border-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-500)]',
          state === 'pending' && 'border border-[color:var(--workspace-border-strong)] text-[color:var(--workspace-text-subtle)]',
        )}
      >
        {state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={3} />
          : state === 'failed' ? <X className="h-3.5 w-3.5" strokeWidth={3} />
            : state === 'current' ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : index + 1}
      </span>
      <div className="min-w-0 pt-0.5">
        <div className={cn('text-[13px] font-medium', state === 'pending' ? 'text-[color:var(--workspace-text-muted)]' : 'text-[color:var(--workspace-text-strong)]')}>
          {label}
        </div>
        {note && <div className="mt-0.5 text-xs text-[color:var(--workspace-status-bad-text)]">{note}</div>}
      </div>
    </li>
  )
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
  const { t, locale } = useT()
  const copy = connectionStatesCopy[locale] ?? connectionStatesCopy.en
  const isLocal = connectionKind === 'local' || hostAddress === 'local'
  const displayName = hostName || hostAddress
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  useEffect(() => () => { if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current) }, [])

  const steps: { stage: string; label: string }[] = isLocal
    ? [
        { stage: 'detect_shell', label: t('terminalConnect.detectShell') },
        { stage: 'spawn_shell', label: t('terminalConnect.spawnShell') },
        { stage: 'allocate_pty', label: t('terminalConnect.allocatePty') },
        { stage: 'prepare_workspace', label: t('terminalConnect.prepareWorkspace') },
      ]
    : [
        { stage: 'resolve_host', label: t('terminalConnect.resolveHost') },
        { stage: 'open_tcp', label: t('terminalConnect.openTcp') },
        { stage: 'verify_host', label: t('terminalConnect.verifyHost') },
        { stage: 'secure_session', label: t('terminalConnect.secureSession') },
        { stage: 'authenticate', label: copy.authenticate },
        { stage: 'prepare_workspace', label: t('terminalConnect.prepareWorkspace') },
      ]

  const header = (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-800)] text-[color:var(--workspace-text-muted)]">
        <TerminalSquare className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-base font-semibold text-[color:var(--workspace-text-strong)]">{displayName}</div>
        {isLocal ? (
          <div className="text-xs text-[color:var(--workspace-text-muted)]">{t('terminalConnect.localShellTag')}</div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-[color:var(--workspace-text-muted)]">
            <span className="truncate font-mono">{hostAddress}</span>
            <HostMetadataLine
              network={network}
              resource={resource}
              regionLabel={hostAddress}
              className="text-xs text-[color:var(--workspace-text-muted)]"
              itemClassName="max-w-[10rem]"
              iconClassName="h-3.5 w-3.5"
            />
          </div>
        )}
      </div>
    </div>
  )

  if (status === 'error') {
    const failure = isLocal ? null : parseConnectFailure(errorMessage)
    const failNote = failure ? [failure.viaJump ? copy.viaJump : null, copy.failNote[failure.reason]].filter(Boolean).join(' · ') : undefined
    const handleCopy = () => {
      if (!errorMessage || !navigator.clipboard) return
      void navigator.clipboard.writeText(errorMessage).then(() => {
        setCopied(true)
        if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
      }).catch(() => {})
    }

    return (
      <div className="relative flex h-full items-center justify-center overflow-y-auto px-4 py-10">
        <div className="sb-card flex w-full max-w-[520px] flex-col gap-4 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]">
              <PlugZap className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[color:var(--workspace-text-strong)]">{copy.failedTitle}</h2>
              <p className="truncate text-[12.5px] text-[color:var(--workspace-text-muted)]">{t('terminalConnect.failedTitle', { host: displayName })}</p>
            </div>
          </div>

          {failure && (
            <ol className="space-y-3" data-testid="session-connection-failed-stage" data-stage={failure.stage}>
              {steps.map((item, index) => {
                const state: StepState = item.stage === failure.stage ? 'failed'
                  : failure.completed.includes(item.stage as RemoteConnectStage) ? 'done' : 'pending'
                return <StageRow key={item.stage} index={index} label={item.label} state={state} note={state === 'failed' ? failNote : undefined} />
              })}
            </ol>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-[color:var(--workspace-text)]">{t('terminalConnect.failureDetails')}</span>
              {errorMessage && (
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copy.copyError}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--workspace-accent-text)] hover:underline"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? copy.copied : copy.copy}
                </button>
              )}
            </div>
            <div
              data-testid="session-connection-error"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[color:var(--workspace-surface-950)] px-3 py-2.5 font-mono text-xs leading-5 text-[color:var(--workspace-text)]"
            >
              {errorMessage || t('terminalConnect.failedFallback')}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[color:var(--workspace-text-muted)]">
            {[displayName, hostAddress !== displayName ? hostAddress : null, isLocal ? t('terminalConnect.localShellTag') : t('terminalConnect.remoteSessionTag')]
              .filter((item): item is string => !!item)
              .map((item) => (
                <span key={item} className="rounded-md bg-[color:var(--workspace-surface-800)] px-2 py-0.5">{item}</span>
              ))}
            {!isLocal && (
              <HostMetadataLine
                network={network}
                resource={resource}
                regionLabel={hostAddress}
                className="text-[11.5px] text-[color:var(--workspace-text-muted)]"
                itemClassName="max-w-[10rem]"
                iconClassName="h-3.5 w-3.5"
              />
            )}
          </div>

          <p className="flex items-start gap-1.5 text-xs leading-5 text-[color:var(--workspace-text-subtle)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{onRetry ? copy.retryHint : t('terminalConnect.failedHint')}</span>
          </p>

          {(onRetry || failure?.hostKeyMismatch) && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {failure?.hostKeyMismatch && (
                <Button type="button" variant="outline" size="sm" onClick={requestKnownHosts} className="gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  {copy.viewKnownHosts}
                </Button>
              )}
              {onRetry && (
                <Button type="button" size="sm" onClick={onRetry} className="gap-1.5">
                  <RotateCw className="h-3.5 w-3.5" />
                  {t('terminalConnect.retry')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const currentIndex = Math.max(steps.findIndex((item) => item.stage === stage), 0)

  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto px-4 py-10">
      <div role="status" aria-busy className="sb-card flex w-full max-w-[520px] flex-col gap-4 px-6 py-5">
        {header}
        <ol className="space-y-3">
          {steps.map((item, index) => (
            <StageRow
              key={item.stage}
              index={index}
              label={item.label}
              state={index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending'}
            />
          ))}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-[color:var(--workspace-text-subtle)]">{isLocal ? copy.localProgressSource : copy.progressSource}</span>
          {onCancel && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {copy.cancel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
