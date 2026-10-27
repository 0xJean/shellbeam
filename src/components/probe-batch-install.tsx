import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, Info, Layers, Loader2, Radar, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { invalidateProbeInstallSources, PROBE_DEPLOYMENT_CHANGED_EVENT } from '@/hooks/use-probe-install-readiness'
import { cancelCompatibleAgent, operateCompatibleAgent, prepareCompatibleAgent, readCompatibleAgent } from '@/lib/compatible-agent'
import { createKomariNodeForHost } from '@/lib/komari-persistence'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { loadCurrentKomariSources } from '@/lib/komari-source-eligibility'
import { fill, probeInstallCopy } from '@/lib/locales/probe-install'
import { probeInstallReadiness, probePreflightFailure, runProbeInstallPool, type ProbeInstallReadiness } from '@/lib/probe-install'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'

const CONCURRENCY = 3

type RowState =
  | { kind: 'checking' }
  | { kind: 'ready'; planId: string; version: string | null }
  | { kind: 'switch'; mode: boolean; node: boolean }
  | { kind: 'blocked'; reason: 'no-ssh' | 'no-server' | 'unsettled' | 'check'; detail?: string }
  | { kind: 'installed' }
  | { kind: 'queued' | 'switching' | 'linking' | 'preparing' | 'installing' }
  | { kind: 'done' | 'pending' }
  | { kind: 'failed'; code: string }
  | { kind: 'skipped' }

interface Row { host: HostProfile; readiness?: ProbeInstallReadiness; state: RowState }

const installable = (state: RowState) => state.kind === 'ready' || state.kind === 'switch'

/** Batch entry shown above the multi-host panel while hosts are selected. */
export function ProbeBatchInstallBar({ hosts }: { hosts: HostProfile[] }) {
  const { locale } = useT()
  const c = probeInstallCopy[locale]
  const [open, setOpen] = useState(false)
  if (hosts.length === 0) return null
  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
      <Radar className="h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-muted-foreground">{c.entryHint}</span>
      <Button size="sm" variant="outline" data-testid="probe-batch-entry" onClick={() => setOpen(true)} className="gap-1.5"><Layers className="h-3.5 w-3.5" />{fill(c.batchEntry, { count: hosts.length })}</Button>
      {open && <ProbeBatchInstallDialog hosts={hosts} open={open} onOpenChange={setOpen} />}
    </div>
  )
}

export function ProbeBatchInstallDialog({ hosts, open, onOpenChange }: { hosts: HostProfile[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { locale } = useT()
  const c = probeInstallCopy[locale]
  const { handleUpdateHost } = useHosts()
  const { activeVaultId, captureVaultScope } = useVault()
  const [rows, setRows] = useState<Row[]>(() => hosts.map((host) => ({ host, state: { kind: 'checking' } })))
  const [phase, setPhase] = useState<'checking' | 'review' | 'running' | 'finished'>('checking')
  const live = useRef(true)
  const stop = useRef(false)
  const plans = useRef(new Set<string>())
  const installing = useRef(false)

  const update = useCallback((hostId: string, state: RowState) => {
    if (live.current) setRows((current) => current.map((row) => row.host.id === hostId ? { ...row, state } : row))
  }, [])

  useEffect(() => {
    live.current = true
    const ids = plans.current
    // A started batch keeps running after the window closes; only an unused preflight is discarded.
    return () => { live.current = false; if (!installing.current) { for (const id of ids) void cancelCompatibleAgent(id).catch(() => {}); ids.clear() } }
  }, [])

  // Read-only preflight: readiness for every host, then prepare for hosts already in server mode.
  useEffect(() => {
    const vaultIds = [...new Set(hosts.map((host) => host.vaultId).filter((id): id is string => !!id))]
    let cancelled = false
    void (async () => {
      const sources = await loadCurrentKomariSources(vaultIds).catch(() => [])
      const assessed = await Promise.all(hosts.map(async (host) => {
        const record = host.vaultId ? await readCompatibleAgent(host.vaultId, host.id).catch(() => null) : null
        return { host, readiness: probeInstallReadiness(host, sources, record) }
      }))
      if (cancelled || !live.current) return
      setRows(assessed.map(({ host, readiness }) => ({
        host, readiness,
        state: readiness.stage === 'installed' ? { kind: 'installed' }
          : readiness.stage === 'ssh-mode' || readiness.stage === 'no-node' ? { kind: 'switch', mode: readiness.stage === 'ssh-mode', node: !readiness.nodeId }
            : readiness.stage === 'ready' ? { kind: 'checking' }
              : { kind: 'blocked', reason: readiness.stage as 'no-ssh' | 'no-server' | 'unsettled' },
      })))
      await runProbeInstallPool(assessed.filter(({ readiness }) => readiness.stage === 'ready'), CONCURRENCY, async ({ host, readiness }) => {
        try {
          const preview = await prepareCompatibleAgent({ vaultId: host.vaultId!, hostId: host.id, integrationId: readiness.integrationId!, action: 'install' })
          plans.current.add(preview.planId)
          update(host.id, { kind: 'ready', planId: preview.planId, version: preview.targetVersion })
        } catch (cause) {
          const failure = probePreflightFailure(cause)
          update(host.id, { kind: 'blocked', reason: 'check', detail: `${fill(c.checkFailed[failure.check], { user: host.username })} · ${failure.code}` })
        }
      }, () => cancelled)
      if (!cancelled && live.current) setPhase('review')
    })()
    return () => { cancelled = true }
  // Preflight runs once per opened dialog; later host refreshes must not restart it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async () => {
    const targets = rows.filter((row) => installable(row.state))
    if (targets.length === 0) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()
    const switching = targets.some((row) => row.state.kind === 'switch' && row.state.mode)
    const linking = targets.some((row) => row.state.kind === 'switch' && row.state.node)
    const answer = await requestUserDecision({
      vaultId: activeVaultId, risk: 'high', isCurrent: current,
      message: fill(c.batchConfirmMessage, { count: targets.length, hosts: targets.map((row) => `· ${row.host.name} (${row.host.username}@${row.host.address})`).join('\n'), switch: (switching ? c.batchSwitchNote : '') + (linking ? c.batchNodeNote : '') }),
    })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    setPhase('running')
    installing.current = true
    stop.current = false
    for (const row of rows) if (!installable(row.state) && row.state.kind !== 'installed') update(row.host.id, { kind: 'skipped' })
    for (const row of targets) update(row.host.id, { kind: 'queued' })
    const touched: Record<string, string[]> = {}
    // Node links share one mapping revision per Server, so create them one at a time.
    let nodeQueue: Promise<unknown> = Promise.resolve()
    const createNodeInTurn = (host: HostProfile, integrationId: string) => {
      const next = nodeQueue.then(() => createKomariNodeForHost({ vaultId: host.vaultId!, integrationId, hostId: host.id }))
      nodeQueue = next.catch(() => {})
      return next
    }
    await runProbeInstallPool(targets, CONCURRENCY, async (row) => {
      const host = row.host
      let planId = row.state.kind === 'ready' ? row.state.planId : null
      try {
        if (!valid()) return update(host.id, { kind: 'skipped' })
        if (row.state.kind === 'switch') {
          if (row.state.mode) {
            update(host.id, { kind: 'switching' })
            await handleUpdateHost(host, { ...host, monitoringMode: 'server' })
          }
          if (row.state.node) {
            update(host.id, { kind: 'linking' })
            await createNodeInTurn(host, row.readiness!.integrationId!)
          }
          update(host.id, { kind: 'preparing' })
          const preview = await prepareCompatibleAgent({ vaultId: host.vaultId!, hostId: host.id, integrationId: row.readiness!.integrationId!, action: 'install' })
          planId = preview.planId
          plans.current.add(planId)
        }
        update(host.id, { kind: 'installing' })
        const record = await operateCompatibleAgent(planId!, true)
        update(host.id, record.status === 'active' ? { kind: 'done' } : record.errorCode ? { kind: 'failed', code: record.errorCode } : { kind: 'pending' })
      } catch (cause) {
        update(host.id, { kind: 'failed', code: probePreflightFailure(cause).code })
      } finally {
        if (planId) { plans.current.delete(planId); void cancelCompatibleAgent(planId).catch(() => {}) }
        if (host.vaultId) (touched[host.vaultId] ??= []).push(host.id)
      }
    }, () => stop.current || !valid())
    installing.current = false
    for (const row of targets) if (stop.current) setRows((list) => list.map((r) => r.host.id === row.host.id && r.state.kind === 'queued' ? { ...r, state: { kind: 'skipped' } } : r))
    for (const [vaultId, hostIds] of Object.entries(touched)) {
      invalidateProbeInstallSources(vaultId)
      window.dispatchEvent(new CustomEvent(PROBE_DEPLOYMENT_CHANGED_EVENT, { detail: { vaultId, hostIds } }))
    }
    if (live.current) setPhase('finished')
  }

  const count = (kinds: RowState['kind'][]) => rows.filter((row) => kinds.includes(row.state.kind)).length
  const ready = count(['ready', 'switch'])
  const running = phase === 'running' || phase === 'finished'

  const label = (state: RowState): { tone: 'ok' | 'warn' | 'bad' | 'run' | 'idle'; text: string; detail?: string } => {
    switch (state.kind) {
      case 'checking': return { tone: 'run', text: c.batchChecking }
      case 'ready': return { tone: 'ok', text: c.batchReady, detail: state.version ? `ShellBeam ${state.version}` : undefined }
      case 'switch': return { tone: 'ok', text: c.batchReady, detail: [state.mode && c.batchSwitch, state.node && c.batchNode].filter(Boolean).join(' · ') }
      case 'blocked': return { tone: state.reason === 'check' ? 'bad' : 'warn', text: state.reason === 'check' ? c.batchFailed : c.batchNeeds[state.reason], detail: state.detail }
      case 'installed': return { tone: 'idle', text: c.batchInstalled }
      case 'queued': return { tone: 'idle', text: c.batchQueued }
      case 'switching': return { tone: 'run', text: c.batchSwitching }
      case 'linking': return { tone: 'run', text: c.batchLinking }
      case 'preparing': return { tone: 'run', text: c.batchPreparing }
      case 'installing': return { tone: 'run', text: c.batchInstalling }
      case 'done': return { tone: 'ok', text: c.batchDone }
      case 'pending': return { tone: 'warn', text: c.batchPending }
      case 'failed': return { tone: 'bad', text: c.batchFailed, detail: `${c.code} ${state.code}` }
      case 'skipped': return { tone: 'idle', text: c.batchSkipped }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="probe-batch-title">
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 md:w-[720px] md:max-w-[95vw]">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div><h2 id="probe-batch-title" className="text-base font-semibold">{c.batchTitle}</h2>
            <p className="text-xs text-muted-foreground">{running ? c.batchRunning : fill(c.batchSubtitle, { count: hosts.length })}</p></div>
          <button type="button" aria-label={c.close} className="rounded-md p-1 text-muted-foreground hover:bg-muted" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-3 overflow-y-auto p-5" data-testid="probe-batch-dialog" data-phase={phase}>
          <div className="overflow-hidden rounded-lg border border-border">
            {rows.map(({ host, state }) => {
              const l = label(state)
              return (
                <div key={host.id} data-testid="probe-batch-row" data-host-id={host.id} data-state={state.kind} className={cn('flex items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0', state.kind === 'skipped' && 'opacity-60')}>
                  <div className="w-48 min-w-0 shrink-0"><b className="block truncate text-[13px] font-semibold">{host.name}</b><small className="block truncate font-mono text-[11px] text-muted-foreground">{host.username}@{host.address}</small></div>
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    {l.tone === 'ok' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-good)]" />
                      : l.tone === 'bad' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-bad)]" />
                        : l.tone === 'warn' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-warn)]" />
                          : l.tone === 'run' ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                            : state.kind === 'skipped' ? <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 text-xs"><span className={cn('block font-semibold', l.tone === 'ok' && 'text-[var(--workspace-status-good-text)]', l.tone === 'bad' && 'text-[var(--workspace-status-bad-text)]', l.tone === 'warn' && 'text-[var(--workspace-status-warn-text)]')}>{l.text}</span>
                      {l.detail && <span className="block break-words text-muted-foreground">{l.detail}</span>}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="flex gap-1.5 text-[11px] text-muted-foreground">{running ? <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{running ? c.batchConcurrency : c.risk}</p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <span className="mr-auto text-[11px] text-muted-foreground">{running
            ? fill(c.batchDoneSummary, { done: count(['done']), failed: count(['failed']), skipped: count(['skipped']) })
            : fill(c.batchSummary, { ready, blocked: count(['blocked']), skipped: count(['installed']) })}</span>
          {phase === 'running' && <Button variant="outline" size="sm" onClick={() => { stop.current = true }}>{c.batchStop}</Button>}
          {phase === 'finished' || phase === 'running'
            ? <Button size="sm" onClick={() => onOpenChange(false)}>{c.close}</Button>
            : <><Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
              <Button size="sm" data-testid="probe-batch-confirm" disabled={phase !== 'review' || ready === 0} onClick={() => void install()}>{phase === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}{fill(c.batchConfirm, { count: ready })}</Button></>}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
