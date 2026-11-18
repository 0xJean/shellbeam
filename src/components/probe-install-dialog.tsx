import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, CircleCheck, CircleDashed, Info, Loader2, Radar, X } from 'lucide-react'
import { InlineServerConnect } from '@/components/inline-server-connect'
import { KomariMappingsPanel } from '@/components/komari-mappings-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useApp } from '@/contexts/app-context'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import {
  invalidateProbeInstallSources,
  PROBE_DEPLOYMENT_CHANGED_EVENT,
  useProbeInstallReadiness,
} from '@/hooks/use-probe-install-readiness'
import {
  cancelCompatibleAgent,
  enableProbeLinger,
  operateCompatibleAgent,
  prepareCompatibleAgent,
  type CompatibleAgentPreview,
  type CompatibleAgentRecord,
} from '@/lib/compatible-agent'
import { createKomariNodeForHost } from '@/lib/komari-persistence'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { fill, probeInstallCopy } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import { PROBE_PREFLIGHT_CHECKS, probePreflightFailure, type ProbePreflightCheck } from '@/lib/probe-install'
import { requestSettingsCategory } from '@/lib/settings-request'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'

type Step = 1 | 2 | 3 | 4
type Check = {
  state: 'idle' | 'running' | 'installing' | 'passed' | 'failed'
  preview?: CompatibleAgentPreview
  failure?: { check: ProbePreflightCheck; code: string }
}
type Outcome = { record: CompatibleAgentRecord | null; error?: string }

/**
 * Automated one-flow installer for the ShellBeam monitoring probe:
 * - Connects ShellBeam Server inline if none exists yet (never kicks user out to Settings)
 * - Automatically switches host to enhanced Server monitoring & registers a node
 * - Runs SSH preflight and installs automatically, pausing ONLY when privilege escalation (linger) or an error occurs.
 */
export function ProbeInstallDialog({
  host,
  open,
  onOpenChange,
  onOpenDetails,
}: {
  host: HostProfile
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenDetails?: () => void
}) {
  const { locale } = useT()
  const c = probeInstallCopy[locale]
  const u = unifiedProbeCopy[locale]
  const agent = compatibleAgentCopy[locale]
  const app = useApp()
  const { hosts, handleUpdateHost } = useHosts()
  const { activeVaultId, vaultStatusState, handleSaveSecret, handleRevealSecret, captureVaultScope } = useVault()
  const { readiness, reload } = useProbeInstallReadiness(host, open)

  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const plan = useRef<string | null>(null)
  const live = useRef(true)
  const autoAttempted = useRef(new Set<string>())

  const dropPlan = useCallback(() => {
    const id = plan.current
    plan.current = null
    if (id) void cancelCompatibleAgent(id).catch(() => {})
  }, [])

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      dropPlan()
    }
  }, [dropPlan])

  useEffect(() => {
    if (!open) {
      dropPlan()
      autoAttempted.current.clear()
      setCheck({ state: 'idle' })
      setOutcome(null)
      setNotice('')
    }
  }, [open, dropPlan])

  const stage = readiness?.stage
  const step: Step = outcome ? 4 : stage === 'no-server' ? 1 : stage === 'ssh-mode' || stage === 'no-node' ? 2 : stage === 'installed' ? 4 : 3
  const vaultId = host.vaultId ?? activeVaultId

  const runCheckAndInstall = useCallback(async (integrationId?: string) => {
    const targetIntegrationId = integrationId ?? readiness?.integrationId
    if (!targetIntegrationId || !vaultId) return
    dropPlan()
    setBusy(true)
    setNotice('')
    setCheck({ state: 'running' })
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    try {
      const preview = await prepareCompatibleAgent({
        vaultId,
        hostId: host.id,
        integrationId: targetIntegrationId,
        action: 'install',
      })
      plan.current = preview.planId
      if (!current()) return
      setCheck({ state: 'installing', preview })

      const planId = preview.planId
      try {
        const record = await operateCompatibleAgent(planId, true)
        if (current()) setOutcome({ record })
      } catch (installCause) {
        if (current()) setOutcome({ record: null, error: probePreflightFailure(installCause).code })
      } finally {
        plan.current = null
        void cancelCompatibleAgent(planId).catch(() => {})
        invalidateProbeInstallSources(vaultId)
        window.dispatchEvent(new CustomEvent(PROBE_DEPLOYMENT_CHANGED_EVENT, { detail: { vaultId, hostIds: [host.id] } }))
        window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))
      }
    } catch (cause) {
      if (current()) setCheck({ state: 'failed', failure: probePreflightFailure(cause) })
    } finally {
      if (live.current) setBusy(false)
    }
  }, [captureVaultScope, dropPlan, host.id, readiness?.integrationId, vaultId])

  const switchModeAuto = useCallback(async () => {
    setBusy(true)
    setNotice('')
    const valid = captureVaultScope()
    try {
      await handleUpdateHost(host, { ...host, monitoringMode: 'server' })
      if (live.current && valid()) reload()
    } catch (cause) {
      if (live.current && valid()) setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (live.current) setBusy(false)
    }
  }, [captureVaultScope, handleUpdateHost, host, reload])

  const createNodeAuto = useCallback(async (integrationId?: string) => {
    const targetIntegrationId = integrationId ?? readiness?.integrationId
    if (!targetIntegrationId || !vaultId) return
    setBusy(true)
    setNotice('')
    const valid = captureVaultScope()
    try {
      await createKomariNodeForHost({ vaultId, integrationId: targetIntegrationId, hostId: host.id })
      if (live.current && valid()) reload()
    } catch (cause) {
      if (live.current && valid()) {
        setNotice(`${c.nodeFailed} · ${c.code} ${probePreflightFailure(cause).code}`)
      }
    } finally {
      if (live.current) setBusy(false)
    }
  }, [c.code, c.nodeFailed, captureVaultScope, host.id, readiness?.integrationId, reload, vaultId])

  // Automated state-machine progression once a Server is present.
  useEffect(() => {
    if (!open || !readiness || busy || outcome) return
    if (stage === 'ssh-mode') {
      const key = `ssh-mode:${host.id}`
      if (autoAttempted.current.has(key)) return
      autoAttempted.current.add(key)
      void switchModeAuto()
    } else if (stage === 'no-node' && readiness.integrationId) {
      const key = `no-node:${host.id}:${readiness.integrationId}`
      if (autoAttempted.current.has(key)) return
      autoAttempted.current.add(key)
      void createNodeAuto(readiness.integrationId)
    } else if (stage === 'ready' && readiness.integrationId && readiness.nodeId) {
      const key = `ready:${host.id}:${readiness.integrationId}:${readiness.nodeId}`
      if (autoAttempted.current.has(key)) return
      autoAttempted.current.add(key)
      void runCheckAndInstall(readiness.integrationId)
    }
  }, [busy, createNodeAuto, host.id, open, outcome, readiness, runCheckAndInstall, stage, switchModeAuto])

  const fixLinger = async () => {
    if (busy || !vaultId) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const answer = await requestUserDecision({
      vaultId,
      risk: 'high',
      isCurrent: current,
      message: fill(c.lingerConfirm, { host: host.name, user: host.username }),
    })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    setBusy(true)
    setNotice('')
    try {
      await enableProbeLinger({ vaultId, hostId: host.id })
    } catch (cause) {
      if (current()) setNotice(/LINGER_SUDO_REQUIRED/.test(String(cause)) ? c.lingerDenied : `${c.code} ${probePreflightFailure(cause).code}`)
      if (live.current) setBusy(false)
      return
    }
    if (live.current) setBusy(false)
    await runCheckAndInstall()
  }

  const openSettings = () => {
    requestSettingsCategory('monitoring')
    app.setPcSidebarNav('settings')
    onOpenChange(false)
  }

  const stepKeys = ['server', 'node', 'check', 'install'] as const
  const stepTitles = {
    server: u.autoStepServer,
    node: u.autoStepNode,
    check: u.autoStepCheck,
    install: u.autoStepInstall,
  }
  const rail = (
    <aside className="flex flex-col gap-1 border-r border-border bg-muted/40 p-4 md:w-56 max-md:flex-row max-md:gap-1.5 max-md:overflow-x-auto max-md:border-b max-md:border-r-0 max-md:px-4 max-md:py-2">
      {stepKeys.map((key, index) => {
        const n = (index + 1) as Step
        const isInstallingStep = check.state === 'installing'
        const effectiveStep: Step = isInstallingStep ? 4 : step
        const done = n < effectiveStep || (effectiveStep === 4 && (outcome?.record?.status === 'active' || stage === 'installed'))
        const cur = n === effectiveStep && !done
        return (
          <div
            key={key}
            className={cn(
              'flex gap-2.5 rounded-lg p-2 max-md:shrink-0 max-md:items-center max-md:gap-1.5 max-md:py-1.5',
              cur && 'bg-background shadow-sm ring-1 ring-border',
            )}
            aria-current={cur ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ring-border',
                done && 'bg-[var(--workspace-status-good)] text-white ring-0',
                cur && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-xs font-semibold', !cur && !done && 'text-muted-foreground')}>{stepTitles[key]}</span>
              <span className="block truncate text-[11px] text-muted-foreground max-md:hidden">{c.stepHints[key]}</span>
            </span>
          </div>
        )
      })}
      <p className="mt-auto flex gap-1.5 pt-4 text-[11px] leading-relaxed text-muted-foreground max-md:hidden">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        {u.autoSubtitle}
      </p>
    </aside>
  )

  const row = (key: ProbePreflightCheck, state: 'ok' | 'bad' | 'run' | 'wait', detail?: string) => (
    <div key={key} data-testid={`probe-check-${key}`} data-state={state} className={cn('flex gap-2.5 rounded-md px-2.5 py-1.5', state === 'bad' && 'bg-[var(--workspace-status-bad-bg)]')}>
      {state === 'ok' ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-good)]" />
      ) : state === 'bad' ? (
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-bad)]" />
      ) : state === 'run' ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
      ) : (
        <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 text-xs">
        <span className="block font-semibold">{c.checks[key]}</span>
        {detail && <span className="block break-words text-muted-foreground">{detail}</span>}
      </span>
    </div>
  )

  let body: React.ReactNode = (
    <div className="flex flex-1 items-center justify-center p-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
  let foot: React.ReactNode = null

  if (readiness && step === 1) {
    body = (
      <section className="space-y-3 overflow-y-auto p-5">
        {vaultId && handleSaveSecret ? (
          <InlineServerConnect
            vaultId={vaultId}
            saveSecret={handleSaveSecret}
            loadSecret={handleRevealSecret}
            onConnected={() => reload()}
          />
        ) : (
          <>
            <h3 className="text-sm font-semibold">{c.serverTitle}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{c.serverBody}</p>
          </>
        )}
      </section>
    )
    foot = (
      <>
        <Button variant="ghost" size="sm" className="mr-auto text-xs text-muted-foreground" onClick={openSettings}>
          {c.openSettings}
        </Button>
        <Button variant="outline" size="sm" onClick={reload}>
          {c.serverRecheck}
        </Button>
      </>
    )
  } else if (readiness && step === 2) {
    body = (
      <section className="space-y-3 overflow-y-auto p-5">
        <div className="flex items-center gap-2.5 rounded-xl border border-primary/25 bg-primary/5 p-3.5 text-xs">
          {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" /> : <Radar className="h-4 w-4 shrink-0 text-primary" />}
          <span className="font-medium text-foreground">{u.autoRunningNode}</span>
        </div>
        {notice && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{notice}</p>}
        {!busy && stage === 'no-node' && (
          <div className="flex items-center gap-2">
            <Button size="sm" data-testid="probe-create-node" onClick={() => void createNodeAuto()}>
              {fill(c.nodeAuto, { host: host.name })}
            </Button>
          </div>
        )}
        {readiness.integrationId && (
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground">{u.autoUseExistingNode}</summary>
            <div className="pt-2">
              <KomariMappingsPanel
                activeVaultId={vaultId}
                hosts={hosts}
                vaultUnlocked={!!vaultStatusState?.unlocked}
                onLoadVaultSecret={handleRevealSecret}
                integrationId={readiness.integrationId}
                initiallyOpen
              />
            </div>
          </details>
        )}
      </section>
    )
  } else if (readiness && step === 3) {
    const failed = check.failure?.check
    const failedIndex = failed ? PROBE_PREFLIGHT_CHECKS.indexOf(failed) : -1
    const rows = PROBE_PREFLIGHT_CHECKS.map((key, index) => {
      if (check.state === 'running') return row(key, 'run')
      if (check.state === 'installing' || check.state === 'passed') return row(key, 'ok')
      if (check.state === 'failed') {
        if (key === failed || (failedIndex < 0 && index === 0)) {
          return row(key, 'bad', `${fill(c.checkFailed[failed ?? 'server'], { user: host.username })} · ${c.code} ${check.failure!.code}`)
        }
        return row(key, index < failedIndex ? 'ok' : 'wait')
      }
      return row(key, 'wait')
    })
    const p = check.preview
    body = (
      <section className="space-y-3 overflow-y-auto p-5">
        <div>
          <h3 className="text-sm font-semibold">
            {check.state === 'failed' ? u.autoActionNeeded : check.state === 'installing' ? u.autoRunningInstall : u.autoRunningCheck}
          </h3>
          <p className="text-xs text-muted-foreground">{host.username}@{host.address} · {c.checkBody}</p>
        </div>
        <div className="grid gap-0.5">{rows}</div>
        {check.state === 'installing' && (
          <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs font-medium text-primary">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>{u.autoRunningInstall}</span>
          </div>
        )}
        {failed === 'account' && (
          <div className="flex flex-wrap items-center gap-2 pl-7">
            <Button size="sm" variant="outline" data-testid="probe-fix-linger" disabled={busy} onClick={() => void fixLinger()}>
              {c.lingerFix}
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">loginctl enable-linger {host.username}</span>
          </div>
        )}
        {notice && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{notice}</p>}
        {failed === 'node' && readiness.integrationId && (
          <div className="pt-1">
            <KomariMappingsPanel
              activeVaultId={vaultId}
              hosts={hosts}
              vaultUnlocked={!!vaultStatusState?.unlocked}
              onLoadVaultSecret={handleRevealSecret}
              integrationId={readiness.integrationId}
              initiallyOpen
            />
          </div>
        )}
        {p && (
          <div className="rounded-lg bg-muted/50 p-3 text-xs">
            <b className="mb-1.5 block font-semibold">{c.planTitle}</b>
            <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
              <li>{fill(c.planDownload, { version: p.targetVersion ?? '—' })}</li>
              <li>{fill(c.planWrite, { scope: p.serviceScope === 'system' ? c.system : c.user, dir: p.dataDirectory })}</li>
              <li>{fill(c.planReport, { node: p.nodeId })}</li>
            </ol>
          </div>
        )}
      </section>
    )
    if (check.state === 'failed' || check.state === 'idle') {
      foot = (
        <Button size="sm" data-testid="probe-install-check" disabled={busy} onClick={() => void runCheckAndInstall()}>
          {u.autoRetry}
        </Button>
      )
    }
  } else if (readiness && step === 4) {
    const record = outcome?.record ?? null
    const ok = stage === 'installed' || record?.status === 'active'
    const statusLabel = record ? agent[record.status as keyof typeof agent] : undefined
    body = (
      <section className="space-y-3 p-5">
        <div className={cn('flex items-center gap-3 rounded-xl p-4', ok ? 'bg-[var(--workspace-status-good-bg)]' : 'bg-[var(--workspace-status-warn-bg)]')}>
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white', ok ? 'bg-[var(--workspace-status-good)]' : 'bg-[var(--workspace-status-warn)]')}>
            {ok ? <Radar className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {ok ? fill(u.autoDoneTitle, { host: host.name }) : outcome?.error || record?.errorCode ? c.failedTitle : c.pendingTitle}
            </h3>
            <p className="text-xs text-muted-foreground">
              {ok ? u.autoDoneBody : typeof statusLabel === 'string' ? statusLabel : ''}
              {(outcome?.error || record?.errorCode) ? ` · ${c.code} ${outcome?.error ?? record?.errorCode}` : ''}
            </p>
          </div>
        </div>
        {record && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{agent.version}</dt>
            <dd className="font-mono">{record.current?.manifest.version ?? '—'}</dd>
            <dt className="text-muted-foreground">{agent.job}</dt>
            <dd className="break-all font-mono">{record.jobId}</dd>
          </dl>
        )}
      </section>
    )
    foot = (
      <>
        {!ok && (
          <Button variant="outline" size="sm" data-testid="probe-install-retry" onClick={() => { setOutcome(null); void runCheckAndInstall() }}>
            {u.autoRetry}
          </Button>
        )}
        {onOpenDetails && (
          <Button variant="outline" size="sm" className="mr-auto" onClick={() => { onOpenChange(false); onOpenDetails() }}>
            {c.details}
          </Button>
        )}
        <Button size="sm" onClick={() => onOpenChange(false)}>
          {c.close}
        </Button>
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="probe-install-title" className="max-md:items-end">
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 md:w-[760px] md:max-w-[95vw] max-md:max-h-[92dvh] max-md:min-h-0 max-md:rounded-t-[20px] max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-2xl">
        <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--workspace-border-strong)] md:hidden" />
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 max-md:items-center max-md:py-3">
          <div>
            <h2 id="probe-install-title" className="text-base font-semibold">
              {fill(u.autoTitle, { host: host.name })}
            </h2>
            <p className="text-xs text-muted-foreground">
              {host.username ? `${host.username}@${host.address}` : host.address} · {fill(c.stepOf, { current: step })}
            </p>
          </div>
          <button
            type="button"
            aria-label={c.close}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted max-md:-mr-2 max-md:flex max-md:h-11 max-md:w-11 max-md:items-center max-md:justify-center"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          className="flex min-h-[360px] flex-1 flex-col overflow-hidden md:flex-row max-md:min-h-0 max-md:overflow-y-auto"
          data-testid="probe-install-dialog"
          data-step={step}
          data-stage={stage ?? 'loading'}
        >
          {rail}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{body}</div>
        </div>
        {foot && (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3 max-md:flex-col-reverse max-md:items-stretch max-md:px-4 [&>button]:max-md:h-11 [&>button]:max-md:w-full [&>button]:max-md:text-[15px] [&>span]:max-md:mr-0 [&>span]:max-md:justify-center">
            {foot}
          </footer>
        )}
      </DialogContent>
    </Dialog>
  )
}
