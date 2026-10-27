import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, CircleCheck, CircleDashed, Info, Loader2, Radar, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { KomariMappingsPanel } from '@/components/komari-mappings-panel'
import { useApp } from '@/contexts/app-context'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { PROBE_DEPLOYMENT_CHANGED_EVENT, useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import { cancelCompatibleAgent, enableProbeLinger, operateCompatibleAgent, prepareCompatibleAgent, type CompatibleAgentPreview, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { listKomariIntegrations } from '@/lib/komari-config'
import { createKomariNodeForHost } from '@/lib/komari-persistence'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { monitoringModeCopy } from '@/lib/locales/monitoring-mode'
import { fill, probeInstallCopy } from '@/lib/locales/probe-install'
import { PROBE_PREFLIGHT_CHECKS, probePreflightFailure, type ProbePreflightCheck } from '@/lib/probe-install'
import { probeReleaseDisplay } from '@/lib/probe-release-identity'
import { requestSettingsCategory } from '@/lib/settings-request'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'

type Step = 1 | 2 | 3 | 4
type Check = { state: 'idle' | 'running' | 'passed' | 'failed'; preview?: CompatibleAgentPreview; failure?: { check: ProbePreflightCheck; code: string } }
type Outcome = { record: CompatibleAgentRecord | null; error?: string }

/**
 * Guided installer for the ShellBeam monitoring probe. It starts at the first
 * unmet prerequisite (service → node → mode), runs the existing read-only
 * prepare as the preflight, and installs through the same confirmed operate
 * call the operations panel uses.
 */
export function ProbeInstallDialog({ host, open, onOpenChange, onOpenDetails }: { host: HostProfile; open: boolean; onOpenChange: (open: boolean) => void; onOpenDetails?: () => void }) {
  const { locale } = useT()
  const c = probeInstallCopy[locale]
  const agent = compatibleAgentCopy[locale]
  const mode = monitoringModeCopy[locale]
  const app = useApp()
  const { hosts, handleUpdateHost } = useHosts()
  const { activeVaultId, vaultStatusState, handleRevealSecret, captureVaultScope } = useVault()
  const { readiness, reload } = useProbeInstallReadiness(host, open)
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const plan = useRef<string | null>(null)
  const live = useRef(true)

  const dropPlan = useCallback(() => {
    const id = plan.current
    plan.current = null
    if (id) void cancelCompatibleAgent(id).catch(() => {})
  }, [])
  useEffect(() => { live.current = true; return () => { live.current = false; dropPlan() } }, [dropPlan])
  useEffect(() => { if (!open) { dropPlan(); setCheck({ state: 'idle' }); setOutcome(null) } }, [open, dropPlan])

  const stage = readiness?.stage
  const step: Step = outcome ? 4 : stage === 'no-server' ? 1 : stage === 'ssh-mode' || stage === 'no-node' ? 2 : stage === 'installed' ? 4 : 3
  const [notice, setNotice] = useState('')
  const vaultId = host.vaultId ?? activeVaultId

  const runCheck = async () => {
    if (!readiness?.integrationId || busy) return
    dropPlan(); setBusy(true); setCheck({ state: 'running' })
    const valid = captureVaultScope()
    try {
      const preview = await prepareCompatibleAgent({ vaultId: vaultId!, hostId: host.id, integrationId: readiness.integrationId, action: 'install' })
      plan.current = preview.planId
      if (live.current && valid()) setCheck({ state: 'passed', preview })
    } catch (cause) {
      if (live.current && valid()) setCheck({ state: 'failed', failure: probePreflightFailure(cause) })
    } finally { if (live.current) setBusy(false) }
  }

  const install = async () => {
    const preview = check.preview
    if (!preview || !plan.current || busy) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const answer = await requestUserDecision({ vaultId, risk: 'high', isCurrent: current, message: `${agent.install} · ${preview.hostName}\n${preview.nodeId}\n${preview.endpoint}\n${preview.transport} · ${agent.account}: ${preview.account} · ${preview.serviceScope === 'system' ? agent.systemService : agent.userService}\n${probeReleaseDisplay(preview.currentArtifact, preview.currentVersion, agent.distributions)} → ${probeReleaseDisplay(preview.targetArtifact, preview.targetVersion, agent.distributions)}\n${preview.dataDirectory}\n${agent.cadence}\n${agent.confirm}\n${agent.preserved}` })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    const id = plan.current
    setBusy(true)
    try {
      const record = await operateCompatibleAgent(id, true)
      if (current()) setOutcome({ record })
    } catch (cause) {
      if (current()) setOutcome({ record: null, error: probePreflightFailure(cause).code })
    } finally {
      plan.current = null
      void cancelCompatibleAgent(id).catch(() => {})
      if (vaultId) window.dispatchEvent(new CustomEvent(PROBE_DEPLOYMENT_CHANGED_EVENT, { detail: { vaultId, hostIds: [host.id] } }))
      if (live.current) setBusy(false)
    }
  }

  const switchMode = async () => {
    if (busy) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const answer = await requestUserDecision({ vaultId, risk: 'low', message: mode.confirmServer, isCurrent: current })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    setBusy(true)
    try {
      await handleUpdateHost(host, { ...host, monitoringMode: 'server' })
      reload()
    } finally { if (live.current) setBusy(false) }
  }

  const createNode = async () => {
    if (busy || !readiness?.integrationId || !vaultId) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const server = (await listKomariIntegrations(vaultId).catch(() => [])).find((item) => item.id === readiness.integrationId)
    const answer = await requestUserDecision({ vaultId, risk: 'low', isCurrent: current, message: fill(c.nodeConfirm, { host: host.name, server: server?.name || server?.endpoint || 'ShellBeam Server' }) })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    setBusy(true); setNotice('')
    try {
      await createKomariNodeForHost({ vaultId, integrationId: readiness.integrationId, hostId: host.id })
      reload()
    } catch (cause) {
      if (current()) setNotice(`${c.nodeFailed} · ${c.code} ${probePreflightFailure(cause).code}`)
    } finally { if (live.current) setBusy(false) }
  }

  const fixLinger = async () => {
    if (busy || !vaultId) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const answer = await requestUserDecision({ vaultId, risk: 'high', isCurrent: current, message: fill(c.lingerConfirm, { host: host.name, user: host.username }) })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    setBusy(true); setNotice('')
    try {
      await enableProbeLinger({ vaultId, hostId: host.id })
    } catch (cause) {
      if (current()) setNotice(/LINGER_SUDO_REQUIRED/.test(String(cause)) ? c.lingerDenied : `${c.code} ${probePreflightFailure(cause).code}`)
      if (live.current) setBusy(false)
      return
    }
    if (live.current) setBusy(false)
    await runCheck()
  }

  const openSettings = () => {
    requestSettingsCategory('monitoring')
    app.setPcSidebarNav('settings')
    onOpenChange(false)
  }

  const stepKeys = ['server', 'node', 'check', 'install'] as const
  const rail = (
    <aside className="flex flex-col gap-1 border-r border-border bg-muted/40 p-4 md:w-56">
      {stepKeys.map((key, index) => {
        const n = (index + 1) as Step
        const done = n < step || (step === 4 && outcome?.record?.status === 'active') || stage === 'installed'
        const cur = n === step && !done
        return (
          <div key={key} className={cn('flex gap-2.5 rounded-lg p-2', cur && 'bg-background shadow-sm ring-1 ring-border')} aria-current={cur ? 'step' : undefined}>
            <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ring-border', done && 'bg-[var(--workspace-status-good)] text-white ring-0', cur && 'bg-primary text-primary-foreground ring-4 ring-primary/20')}>
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-xs font-semibold', !cur && !done && 'text-muted-foreground')}>{c.steps[key]}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{c.stepHints[key]}</span>
            </span>
          </div>
        )
      })}
      <p className="mt-auto flex gap-1.5 pt-4 text-[11px] leading-relaxed text-muted-foreground"><Info className="mt-0.5 h-3 w-3 shrink-0" />{c.railNote}</p>
    </aside>
  )

  const row = (key: ProbePreflightCheck, state: 'ok' | 'bad' | 'run' | 'wait', detail?: string) => (
    <div key={key} data-testid={`probe-check-${key}`} data-state={state} className={cn('flex gap-2.5 rounded-md px-2.5 py-1.5', state === 'bad' && 'bg-[var(--workspace-status-bad-bg)]')}>
      {state === 'ok' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-good)]" />
        : state === 'bad' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-bad)]" />
          : state === 'run' ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
            : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 text-xs"><span className="block font-semibold">{c.checks[key]}</span>{detail && <span className="block break-words text-muted-foreground">{detail}</span>}</span>
    </div>
  )

  let body: React.ReactNode = <div className="flex flex-1 items-center justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  let foot: React.ReactNode = null
  if (readiness && step === 1) {
    body = <section className="space-y-3 p-5"><h3 className="text-sm font-semibold">{c.serverTitle}</h3><p className="text-xs leading-relaxed text-muted-foreground">{c.serverBody}</p></section>
    foot = <><Button variant="outline" size="sm" onClick={reload}>{c.serverRecheck}</Button><Button size="sm" onClick={openSettings}>{c.openSettings}</Button></>
  } else if (readiness && step === 2 && stage === 'ssh-mode') {
    body = <section className="space-y-3 p-5"><h3 className="text-sm font-semibold">{fill(c.modeTitle, { host: host.name })}</h3><p className="text-xs leading-relaxed text-muted-foreground">{c.modeBody}</p></section>
    foot = <Button size="sm" disabled={busy} onClick={() => void switchMode()}>{c.switchMode}</Button>
  } else if (readiness && step === 2) {
    body = <section className="space-y-3 overflow-y-auto p-5"><h3 className="text-sm font-semibold">{fill(c.nodeTitle, { host: host.name })}</h3><p className="text-xs leading-relaxed text-muted-foreground">{c.nodeBody}</p>
      <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <Radar className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" />
        <div className="min-w-0 flex-1"><b className="block text-xs font-semibold">{fill(c.nodeAuto, { host: host.name })}</b><span className="block text-[11px] text-muted-foreground">{c.nodeAutoHint}</span></div>
        <Button size="sm" data-testid="probe-create-node" disabled={busy} onClick={() => void createNode()}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{fill(c.nodeAuto, { host: host.name })}</Button>
      </div>
      {notice && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{notice}</p>}
      <details className="text-xs"><summary className="cursor-pointer font-medium text-muted-foreground">{c.nodeOr}</summary>
        <div className="pt-2"><KomariMappingsPanel activeVaultId={vaultId} hosts={hosts} vaultUnlocked={!!vaultStatusState?.unlocked} onLoadVaultSecret={handleRevealSecret} integrationId={readiness.integrationId} initiallyOpen /></div></details></section>
  } else if (readiness && step === 3) {
    const failed = check.failure?.check
    const failedIndex = failed ? PROBE_PREFLIGHT_CHECKS.indexOf(failed) : -1
    const rows = PROBE_PREFLIGHT_CHECKS.map((key, index) => {
      if (check.state === 'running') return row(key, 'run')
      if (check.state === 'passed') return row(key, 'ok')
      if (check.state === 'failed') {
        if (key === failed || (failedIndex < 0 && index === 0)) return row(key, 'bad', `${fill(c.checkFailed[failed ?? 'server'], { user: host.username })} · ${c.code} ${check.failure!.code}`)
        return row(key, index < failedIndex ? 'ok' : 'wait')
      }
      return row(key, 'wait')
    })
    const p = check.preview
    body = <section className="space-y-3 overflow-y-auto p-5">
      <div><h3 className="text-sm font-semibold">{fill(c.checkTitle, { host: host.name })}</h3><p className="text-xs text-muted-foreground">{host.username}@{host.address} · {c.checkBody}</p></div>
      <div className="grid gap-0.5">{rows}</div>
      {failed === 'account' && <div className="flex flex-wrap items-center gap-2 pl-8"><Button size="sm" variant="outline" data-testid="probe-fix-linger" disabled={busy} onClick={() => void fixLinger()}>{c.lingerFix}</Button><span className="font-mono text-[11px] text-muted-foreground">loginctl enable-linger {host.username}</span></div>}
      {notice && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{notice}</p>}
      {failed === 'node' && <div className="pt-1"><KomariMappingsPanel activeVaultId={vaultId} hosts={hosts} vaultUnlocked={!!vaultStatusState?.unlocked} onLoadVaultSecret={handleRevealSecret} integrationId={readiness.integrationId} initiallyOpen /></div>}
      {p && <div className="rounded-lg bg-muted/50 p-3 text-xs">
        <b className="mb-1.5 block font-semibold">{c.planTitle}</b>
        <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
          <li>{fill(c.planDownload, { version: p.targetVersion ?? '—' })}</li>
          <li>{fill(c.planWrite, { scope: p.serviceScope === 'system' ? c.system : c.user, dir: p.dataDirectory })}</li>
          <li>{fill(c.planReport, { node: p.nodeId })}</li>
        </ol>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{fill(c.via, { transport: p.transport, account: p.account })}</p>
      </div>}
    </section>
    foot = check.state === 'passed'
      ? <><span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldAlert className="h-3.5 w-3.5" />{c.risk}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void runCheck()}>{c.rerun}</Button><Button size="sm" data-testid="probe-install-confirm" disabled={busy} onClick={() => void install()}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}{busy ? c.installing : c.install}</Button></>
      : <Button size="sm" data-testid="probe-install-check" disabled={busy || check.state === 'running'} onClick={() => void runCheck()}>{check.state === 'running' ? c.checking : check.state === 'failed' ? c.rerun : c.runCheck}</Button>
  } else if (readiness && step === 4) {
    const record = outcome?.record ?? null
    const ok = stage === 'installed' || record?.status === 'active'
    const statusLabel = record ? agent[record.status as keyof typeof agent] : undefined
    body = <section className="space-y-3 p-5">
      <div className={cn('flex items-center gap-3 rounded-xl p-4', ok ? 'bg-[var(--workspace-status-good-bg)]' : 'bg-[var(--workspace-status-warn-bg)]')}>
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white', ok ? 'bg-[var(--workspace-status-good)]' : 'bg-[var(--workspace-status-warn)]')}>{ok ? <Radar className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}</span>
        <div className="min-w-0"><h3 className="text-sm font-semibold">{ok ? fill(c.doneTitle, { host: host.name }) : outcome?.error || record?.errorCode ? c.failedTitle : c.pendingTitle}</h3>
          <p className="text-xs text-muted-foreground">{ok ? c.doneBody : typeof statusLabel === 'string' ? statusLabel : ''}{(outcome?.error || record?.errorCode) ? ` · ${c.code} ${outcome?.error ?? record?.errorCode}` : ''}</p></div>
      </div>
      {record && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt className="text-muted-foreground">{agent.version}</dt><dd>{record.current?.manifest.version ?? '—'}</dd><dt className="text-muted-foreground">{agent.job}</dt><dd className="break-all font-mono">{record.jobId}</dd></dl>}
    </section>
    foot = <>{onOpenDetails && <Button variant="outline" size="sm" className="mr-auto" onClick={() => { onOpenChange(false); onOpenDetails() }}>{c.details}</Button>}<Button size="sm" onClick={() => onOpenChange(false)}>{c.close}</Button></>
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="probe-install-title">
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 md:w-[760px] md:max-w-[95vw]">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div><h2 id="probe-install-title" className="text-base font-semibold">{c.title}</h2><p className="text-xs text-muted-foreground">{host.name} · {fill(c.stepOf, { current: step })}</p></div>
          <button type="button" aria-label={c.close} className="rounded-md p-1 text-muted-foreground hover:bg-muted" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></button>
        </header>
        <div className="flex min-h-[360px] flex-1 flex-col overflow-hidden md:flex-row" data-testid="probe-install-dialog" data-step={step} data-stage={stage ?? 'loading'}>
          {rail}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{body}</div>
        </div>
        {foot && <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{foot}</footer>}
      </DialogContent>
    </Dialog>
  )
}
