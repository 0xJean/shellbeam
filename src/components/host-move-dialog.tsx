import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, KeyRound, Loader2, Lock, Plus, RotateCw, Route, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { hostMoveBlocked, moveHostsToVault, planHostMove, type HostMovePlan, type HostMoveRequest, type HostMoveResult } from '@/lib/host-move'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { hostMoveCopy } from '@/lib/locales/host-move'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import { vaultUnlock } from '@/lib/vault'
import { clearHostLocalData } from '@/lib/vault-local-cleanup'
import type { VaultMeta } from '@/lib/vaults'

interface HostMoveDialogProps {
  open: boolean
  sourceVaultId: string
  vaults: ReadonlyArray<Pick<VaultMeta, 'id' | 'name'>>
  /** The hosts the user picked; the plan adds the jump hosts they need. */
  hosts: ReadonlyArray<Pick<HostProfile, 'id' | 'name'>>
  onOpenChange: (open: boolean) => void
  /** Runs after every finished move (also one with warnings), once local caches are cleared. */
  onMoved?: (movedHostIds: string[]) => void | Promise<void>
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const section = 'rounded-lg border border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-950)] p-3'
const heading = 'text-xs font-semibold text-[color:var(--workspace-text-strong)]'

export function HostMoveDialog({ open, sourceVaultId, vaults, hosts, onOpenChange, onMoved }: HostMoveDialogProps) {
  const { locale } = useT()
  const c = hostMoveCopy[locale] ?? hostMoveCopy.en
  const titleId = useId()
  const targets = vaults.filter((vault) => vault.id !== sourceVaultId)
  const [targetId, setTargetId] = useState(() => targets[0]?.id ?? '')
  const [hostIds, setHostIds] = useState(() => hosts.map((host) => host.id))
  // Bumped to plan again with the same inputs, e.g. after unlocking a Vault.
  const [planNonce, setPlanNonce] = useState(0)
  const planKey = JSON.stringify([sourceVaultId, targetId, hostIds, planNonce])
  const [planState, setPlanState] = useState<{ key: string; plan?: HostMovePlan; error?: string } | null>(null)
  const [phase, setPhase] = useState<'plan' | 'moving' | 'done'>('plan')
  const [request, setRequest] = useState<HostMoveRequest | null>(null)
  const [result, setResult] = useState<HostMoveResult | null>(null)
  const [moveError, setMoveError] = useState('')

  useEffect(() => {
    if (!open || !targetId || phase !== 'plan') return
    let cancelled = false
    planHostMove({ sourceVaultId, targetVaultId: targetId, hostIds })
      .then((plan) => { if (!cancelled) setPlanState({ key: planKey, plan }) })
      .catch((error: unknown) => { if (!cancelled) setPlanState({ key: planKey, error: errorText(error) }) })
    return () => { cancelled = true }
  }, [open, phase, sourceVaultId, targetId, hostIds, planKey])

  const planning = phase === 'plan' && !!targetId && planState?.key !== planKey
  const plan = planState?.key === planKey ? planState.plan ?? null : null
  const planError = planState?.key === planKey ? planState.error ?? '' : ''
  const blocked = !plan || hostMoveBlocked(plan)
  const vaultName = (id: string) => vaults.find((vault) => vault.id === id)?.name || c.unnamed
  const names = new Map<string, string>(hosts.map((host) => [host.id, host.name]))
  if (plan) for (const row of [...plan.hosts, ...plan.addedJumpHosts, ...plan.blockingDependents, ...plan.conflicts]) names.set(row.id, row.name)
  const nameList = (ids: readonly string[]) => ids.map((id) => names.get(id) || id).join(', ')
  const jumpHostFor = new Map(plan?.addedJumpHosts.map((row) => [row.id, row.requiredBy]) ?? [])

  async function runMove(next: HostMoveRequest) {
    setPhase('moving'); setMoveError('')
    try {
      const moved = await moveHostsToVault(next)
      setRequest(next); setResult(moved); setPhase('done')
      clearHostLocalData(next.sourceVaultId, moved.movedHostIds)
      try { await onMoved?.(moved.movedHostIds) } catch { /* The hosts moved; a failed refresh shows on the next one. */ }
    } catch (error) {
      setMoveError(errorText(error))
      // A failed retry keeps the result view so the user can retry again.
      setPhase(request ? 'done' : 'plan')
    }
  }

  const close = () => { if (phase !== 'moving') onOpenChange(false) }
  const replan = () => setPlanNonce((value) => value + 1)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }} labelledBy={titleId}>
      <DialogContent className="sb-card md:w-[600px] md:max-w-[600px] max-md:flex max-md:min-h-dvh max-md:flex-col max-md:!rounded-none max-md:!border-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-[env(safe-area-inset-top)]">
        <div data-testid="host-move-dialog" data-phase={phase} className="max-md:flex max-md:flex-1 max-md:flex-col">
          <div className="space-y-4 px-5 pb-5 pt-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 id={titleId} className="text-lg font-semibold text-[color:var(--workspace-text-strong)]">{c.title}</h3>
                <p className="mt-1.5 text-[13px] text-[color:var(--workspace-text-muted)]">{fill(c.subtitle, { count: hostIds.length })}</p>
              </div>
              <button type="button" onClick={close} disabled={phase === 'moving'} aria-label={c.close}
                className="rounded-md p-1 text-[color:var(--workspace-text-subtle)] transition-colors hover:bg-[color:var(--workspace-surface-800)] hover:text-[color:var(--workspace-text-strong)] disabled:opacity-50 max-md:-mr-2 max-md:-mt-2 max-md:flex max-md:h-11 max-md:w-11 max-md:items-center max-md:justify-center">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div data-testid="host-move-route" className="flex min-w-0 items-center gap-2 text-[13px]">
              <span className="min-w-0 truncate rounded-md bg-[color:var(--workspace-surface-800)] px-2 py-1 font-medium text-[color:var(--workspace-text)]">{vaultName(sourceVaultId)}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-[color:var(--workspace-text-subtle)]" />
              <span className="min-w-0 truncate rounded-md bg-[color:var(--workspace-accent-subtle)] px-2 py-1 font-medium text-[color:var(--workspace-accent-text)]">{targetId ? vaultName(targetId) : '—'}</span>
            </div>

            {phase !== 'done' && (targets.length === 0 ? <p className="text-[13px] text-[color:var(--workspace-text-muted)]">{c.noOtherVault}</p> : (
              <div>
                <div id={`${titleId}-target`} className={heading}>{c.target}</div>
                <div role="radiogroup" aria-labelledby={`${titleId}-target`} className="mt-2 flex flex-wrap gap-1.5">
                  {targets.map((vault) => (
                    <button key={vault.id} type="button" role="radio" aria-checked={vault.id === targetId} disabled={phase === 'moving'}
                      onClick={() => setTargetId(vault.id)}
                      className={cn('h-9 max-w-full truncate rounded-lg border px-3 text-[13px] transition-colors disabled:opacity-60 max-md:h-11',
                        vault.id === targetId
                          ? 'border-[color:var(--workspace-accent-solid)] bg-[color:var(--workspace-accent-subtle)] font-medium text-[color:var(--workspace-accent-text)]'
                          : 'border-[color:var(--workspace-border-soft)] text-[color:var(--workspace-text)] hover:bg-[color:var(--workspace-surface-800)]')}>
                      {vault.name || c.unnamed}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {phase === 'plan' && planning && <p role="status" className="flex items-center gap-2 text-[13px] text-[color:var(--workspace-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{c.planning}</p>}
            {phase === 'plan' && planError && (
              <Notice tone="bad" testId="host-move-plan-error">
                <p>{fill(c.planFailed, { error: planError })}</p>
                <Button size="sm" variant="outline" className="mt-2 h-8 text-xs" onClick={replan}>{c.replan}</Button>
              </Notice>
            )}

            {phase !== 'done' && plan && <PlanDetails plan={plan} c={c} nameList={nameList} jumpHostFor={jumpHostFor} disabled={phase === 'moving'}
              sourceName={vaultName(sourceVaultId)} targetName={vaultName(targetId)} sourceVaultId={sourceVaultId} targetVaultId={targetId}
              onUnlocked={replan}
              onAddDependents={() => setHostIds((ids) => [...new Set([...ids, ...plan.blockingDependents.map((row) => row.id)])])} />}

            {phase === 'moving' && <p role="status" className="flex items-center gap-2 text-[13px] text-[color:var(--workspace-text)]"><Loader2 className="h-4 w-4 animate-spin" />{c.moving}</p>}

            {phase === 'done' && result && request && (
              <div className="space-y-3">
                <p data-testid="host-move-done" className="flex items-start gap-2 text-[13px] text-[color:var(--workspace-status-good-text)]">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  {fill(c.done, { count: result.movedHostIds.length, vault: vaultName(request.targetVaultId) })}
                </p>
                {result.warnings.length > 0 && (
                  <Notice tone="warn" testId="host-move-warnings">
                    <p>{c.warnings}</p>
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[color:var(--workspace-text)]">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                  </Notice>
                )}
              </div>
            )}

            {moveError && <Notice tone="bad" testId="host-move-error"><p>{fill(c.moveFailed, { error: moveError })}</p></Notice>}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3.5 max-md:mt-auto max-md:flex-col-reverse max-md:items-stretch max-md:border-t-0 max-md:pb-4 [&>button]:max-md:h-11 [&>button]:max-md:w-full">
            {phase === 'done' ? (
              <>
                {request && (result?.warnings.length || moveError) ? (
                  <Button variant="outline" className="gap-1.5" data-testid="host-move-retry" onClick={() => void runMove(request)}><RotateCw className="h-4 w-4" />{c.retry}</Button>
                ) : null}
                <Button onClick={close}>{c.close}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={close} disabled={phase === 'moving'}>{c.cancel}</Button>
                <Button data-testid="host-move-confirm" disabled={blocked || planning || phase === 'moving'} className="gap-1.5"
                  onClick={() => void runMove({ sourceVaultId, targetVaultId: targetId, hostIds })}>
                  {phase === 'moving' && <Loader2 className="h-4 w-4 animate-spin" />}
                  {fill(c.confirm, { count: plan?.hosts.length ?? hostIds.length })}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type Copy = (typeof hostMoveCopy)[keyof typeof hostMoveCopy]

function PlanDetails({ plan, c, nameList, jumpHostFor, disabled, sourceName, targetName, sourceVaultId, targetVaultId, onUnlocked, onAddDependents }: {
  plan: HostMovePlan; c: Copy; nameList: (ids: readonly string[]) => string; jumpHostFor: Map<string, string[]>; disabled: boolean
  sourceName: string; targetName: string; sourceVaultId: string; targetVaultId: string; onUnlocked: () => void; onAddDependents: () => void
}) {
  const records = ([
    ['portForwards', c.portForwards], ['knownHosts', c.knownHosts], ['commandHistory', c.commandHistory], ['activity', c.activity], ['databaseRows', c.databaseRows],
  ] as const).filter(([key]) => plan.records[key] > 0)
  const { secrets } = plan
  return (
    <div className="space-y-3" data-testid="host-move-plan">
      {plan.targetUninitialized && (
        <Notice tone="bad" testId="host-move-uninitialized">
          <p className="font-semibold text-[color:var(--workspace-text-strong)]">{fill(c.uninitialized, { vault: targetName })}</p>
          <p className="mt-1">{c.uninitializedBody}</p>
        </Notice>
      )}
      {!plan.sourceUnlocked && <UnlockField c={c} vaultId={sourceVaultId} vaultName={sourceName} disabled={disabled} onUnlocked={onUnlocked} />}
      {!plan.targetUnlocked && !plan.targetUninitialized && <UnlockField c={c} vaultId={targetVaultId} vaultName={targetName} disabled={disabled} onUnlocked={onUnlocked} />}

      {plan.blockingDependents.length > 0 && (
        <Notice tone="warn" testId="host-move-dependents">
          <p className="font-semibold text-[color:var(--workspace-text-strong)]">{c.dependents}</p>
          <p className="mt-1">{c.dependentsBody}</p>
          <ul className="mt-2 space-y-1">
            {plan.blockingDependents.map((row) => (
              <li key={row.id} className="min-w-0"><span className="font-medium text-[color:var(--workspace-text-strong)]">{row.name}</span> <span className="text-[color:var(--workspace-text-muted)]">· {fill(c.dependsOn, { names: nameList(row.dependsOn) })}</span></li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="mt-2 h-8 gap-1.5 text-xs max-md:h-10" disabled={disabled} data-testid="host-move-add-dependents" onClick={onAddDependents}><Plus className="h-3.5 w-3.5" />{c.addDependents}</Button>
        </Notice>
      )}

      {plan.conflicts.length > 0 && (
        <Notice tone="bad" testId="host-move-conflicts">
          <p className="font-semibold text-[color:var(--workspace-text-strong)]">{c.conflicts}</p>
          <p className="mt-1">{c.conflictsBody}</p>
          <ul className="mt-2 space-y-1">
            {plan.conflicts.map((row) => <li key={row.id}><span className="font-medium text-[color:var(--workspace-text-strong)]">{row.name}</span> <span className="text-[color:var(--workspace-text-muted)]">· {row.reason}</span></li>)}
          </ul>
        </Notice>
      )}

      <div className={section}>
        <div className={heading}>{c.hosts}</div>
        <ul data-testid="host-move-hosts" className="mt-2 space-y-1.5 text-[13px]">
          {plan.hosts.map((row) => {
            const requiredBy = jumpHostFor.get(row.id)
            return (
              <li key={row.id} data-host-id={row.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 truncate font-medium text-[color:var(--workspace-text)]">{row.name}</span>
                {requiredBy && <span data-testid="host-move-jump-host" className="inline-flex items-center gap-1 rounded-md bg-[color:var(--workspace-status-info-bg)] px-1.5 py-0.5 text-[11.5px] text-[color:var(--workspace-status-info-text)]"><Route className="h-3 w-3" />{fill(c.jumpHost, { names: nameList(requiredBy) })}</span>}
              </li>
            )
          })}
        </ul>
      </div>

      {(secrets.moved > 0 || secrets.copied > 0 || secrets.renamed.length > 0) && (
        <div className={section} data-testid="host-move-secrets">
          <div className={cn(heading, 'flex items-center gap-1.5')}><KeyRound className="h-3.5 w-3.5" />{c.credentials}</div>
          <ul className="mt-2 space-y-1 text-[13px] text-[color:var(--workspace-text)]">
            {secrets.moved > 0 && <li>{fill(c.secretsMoved, { count: secrets.moved })}</li>}
            {secrets.copied > 0 && <li>{fill(c.secretsCopied, { count: secrets.copied })}</li>}
          </ul>
          {secrets.renamed.length > 0 && (
            <div className="mt-2 text-[13px]">
              <p className="text-[color:var(--workspace-text-muted)]">{c.renamed}</p>
              <ul className="mt-1 space-y-0.5">
                {secrets.renamed.map((row) => <li key={row.from} className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-[color:var(--workspace-text)]"><span className="break-all">{row.from}</span><ArrowRight className="h-3 w-3 shrink-0 text-[color:var(--workspace-text-subtle)]" /><span className="break-all">{row.to}</span></li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {records.length > 0 && (
        <div className={section} data-testid="host-move-records">
          <div className={heading}>{c.records}</div>
          <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
            {records.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="min-w-0 truncate text-[color:var(--workspace-text-muted)]">{label}</dt>
                <dd className="text-right tabular-nums text-[color:var(--workspace-text)]">{plan.records[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {plan.mcpClientsAffected.length > 0 && (
        <Notice tone="warn" testId="host-move-mcp">
          <p className="font-semibold text-[color:var(--workspace-text-strong)]">{c.mcp}</p>
          <p className="mt-1">{c.mcpBody}</p>
          <p className="mt-1.5 font-medium text-[color:var(--workspace-text)]">{plan.mcpClientsAffected.map((row) => row.name).join(', ')}</p>
        </Notice>
      )}
    </div>
  )
}

function UnlockField({ c, vaultId, vaultName, disabled, onUnlocked }: { c: Copy; vaultId: string; vaultName: string; disabled: boolean; onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputId = useId()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true); setError('')
    try {
      await vaultUnlock(password, vaultId)
      setPassword('')
      onUnlocked()
    } catch (unlockError) {
      setError(errorText(unlockError))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form data-testid="host-move-unlock" data-vault-id={vaultId} onSubmit={(event) => void submit(event)}
      className="rounded-lg border border-[color:var(--workspace-status-warn-border)] bg-[color:var(--workspace-status-warn-bg)] p-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-semibold text-[color:var(--workspace-text-strong)]"><Lock className="h-3.5 w-3.5 text-[color:var(--workspace-status-warn-text)]" />{fill(c.locked, { vault: vaultName })}</p>
      <p className="mt-1 text-[color:var(--workspace-text-muted)]">{c.lockedBody}</p>
      <div className="mt-2 flex gap-2 max-md:flex-col">
        <label htmlFor={inputId} className="sr-only">{c.masterPassword}</label>
        <Input id={inputId} type="password" autoComplete="current-password" placeholder={c.masterPassword} value={password} disabled={disabled || busy}
          onChange={(event) => setPassword(event.target.value)} className="h-9 min-w-0 flex-1 max-md:h-11" />
        <Button type="submit" size="sm" className="h-9 shrink-0 max-md:h-11" disabled={disabled || busy || !password}>{busy ? c.unlocking : c.unlock}</Button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-[color:var(--workspace-status-bad-text)]">{fill(c.unlockFailed, { error })}</p>}
    </form>
  )
}

function Notice({ tone, testId, children }: { tone: 'warn' | 'bad'; testId?: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className={cn('flex gap-2.5 rounded-lg border p-3 text-[13px] text-[color:var(--workspace-text-muted)]',
      tone === 'bad' ? 'border-[color:var(--workspace-status-bad-border)] bg-[color:var(--workspace-status-bad-bg)]' : 'border-[color:var(--workspace-status-warn-border)] bg-[color:var(--workspace-status-warn-bg)]')}>
      <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[color:var(--workspace-status-warn-text)]')} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
