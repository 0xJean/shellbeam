import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import {
  SHELLBEAM_AGENT_HEARTBEAT_TTL_MS,
  checkShellbeamAgent,
  buildShellbeamAgentPlan,
  listShellbeamAgents,
  runShellbeamAgentOperation,
  upsertShellbeamAgent,
  type ShellbeamAgentRecord,
} from '@/lib/shellbeam-agent'
import { loadShellbeamAgentCatalogRelease } from '@/lib/shellbeam-agent-catalog'
import { loadShellbeamAgentReleaseSettings } from '@/lib/shellbeam-agent-release-settings'
import { shellbeamAgentReleaseParamsSummary, type ValidatedShellbeamAgentRelease } from '@/lib/shellbeam-agent-release'
import { runShellbeamAgentArtifactOperation, type ShellbeamAgentArtifactPolicy } from '@/lib/shellbeam-agent-artifact'
import { DEFAULT_VAULT_ID } from '@/lib/vaults'
import { AlertTriangle, BadgeCheck, Bot, CheckCircle2, CircleDashed, CodeXml, Download, RefreshCw, ScanSearch, Shield, ShieldAlert, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ShellbeamAgentHistoryView } from './shellbeam-agent-history-view'

interface ShellbeamAgentPanelProps {
  host: HostProfile | null
  vaultId?: string
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  /** Optional embedded trusted artifact for controlled distributions. The
   * production panel loads signed release catalogs from saved release policy. */
  artifactManifest?: unknown
  artifactPolicy?: ShellbeamAgentArtifactPolicy
  /** v3 overview: always-open compact card instead of the expandable section. */
  variant?: 'panel' | 'card'
  className?: string
}

function statusTone(status: ShellbeamAgentRecord['status']) {
  if (status === 'installed') return 'text-[color:var(--workspace-status-good-text)]'
  if (status === 'offline' || status === 'failed') return 'text-[color:var(--workspace-status-bad-text)]'
  if (status === 'unsupported') return 'text-[color:var(--workspace-status-warn-text)]'
  return 'text-[var(--workspace-text-muted)]'
}

export function ShellbeamAgentPanel({ host, vaultId = host?.vaultId ?? DEFAULT_VAULT_ID, resolveAuthSecret, artifactManifest, artifactPolicy, variant = 'panel', className }: ShellbeamAgentPanelProps) {
  const { t, locale } = useT()
  const copy = workspaceOverviewCopy[locale]
  const scopeKey = host && (!host.vaultId || host.vaultId === vaultId) ? JSON.stringify([
    vaultId, host.id, host.address, host.port, host.username, host.authType,
    host.secretKeyRef, host.passwordKeyRef, host.privateKeyRef,
    host.jumpHostId, host.jumpHost, host.jumpPort, host.jumpUser, host.updatedAt,
  ]) : null
  const scopeRef = useRef({ key: scopeKey, generation: 0 })
  if (scopeRef.current.key !== scopeKey) scopeRef.current = { key: scopeKey, generation: scopeRef.current.generation + 1 }
  const scopeGeneration = scopeRef.current.generation
  const scopeToken = JSON.stringify([scopeKey, scopeGeneration])
  const [expandedScope, setExpandedScope] = useState<string | null>(null)
  const expanded = expandedScope === scopeToken
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const isCurrent = () => mountedRef.current && scopeRef.current.key === scopeKey && scopeRef.current.generation === scopeGeneration
  const [recordState, setRecordState] = useState<{ key: string; value: ShellbeamAgentRecord | null } | null>(null)
  const setRecord = useCallback((value: ShellbeamAgentRecord | null) => setRecordState({ key: scopeToken, value }), [scopeToken])
  const storedRecord = recordState?.key === scopeToken ? recordState.value : null
  const record = scopeKey && storedRecord?.hostId === host?.id && storedRecord?.vaultId === vaultId ? storedRecord : null
  const [loadingState, setLoadingState] = useState({ key: scopeToken, value: false })
  const loading = loadingState.key === scopeToken && loadingState.value
  const setLoading = useCallback((value: boolean) => setLoadingState({ key: scopeToken, value }), [scopeToken])
  const [runningState, setRunningState] = useState<{ key: string; value: 'install' | 'upgrade' | 'uninstall' | null }>({ key: scopeToken, value: null })
  const running = runningState.key === scopeToken ? runningState.value : null
  const setRunning = useCallback((value: 'install' | 'upgrade' | 'uninstall' | null) => setRunningState({ key: scopeToken, value }), [scopeToken])
  const [errorEntry, setErrorEntry] = useState<{ key: string; value: string } | null>(null)
  const error = errorEntry?.key === scopeToken ? errorEntry?.value : ''
  const setError = useCallback((value: string) => setErrorEntry({ key: scopeToken, value }), [scopeToken])
  const [releaseLoadingState, setReleaseLoadingState] = useState({ key: scopeToken, value: false })
  const releaseLoading = releaseLoadingState.key === scopeToken && releaseLoadingState.value
  const setReleaseLoading = useCallback((value: boolean) => setReleaseLoadingState({ key: scopeToken, value }), [scopeToken])
  const [releaseState, setReleaseState] = useState<{ key: string; vaultId: string; hostId: string; release: ValidatedShellbeamAgentRelease; policy: ShellbeamAgentArtifactPolicy } | null>(null)
  const release = scopeKey && releaseState?.key === scopeToken && releaseState.hostId === host?.id && releaseState.vaultId === vaultId ? releaseState : null
  const selectedManifest = release?.release.manifest.artifact ?? artifactManifest
  const selectedPolicy = release?.policy ?? artifactPolicy
  const artifactReady = Boolean(selectedManifest && selectedPolicy)

  const loadFailed = t('workspace.agentProbe.loadFailed')
  const hostId = host?.id
  useEffect(() => {
    let cancelled = false
    if (!hostId || !scopeKey) return
    setLoading(true)
    setError('')
    void listShellbeamAgents({ vaultId, hostId }).then((records) => {
      if (!cancelled) setRecord(records.find((entry) => entry.hostId === hostId && entry.vaultId === vaultId) ?? null)
    }).catch(() => {
      if (!cancelled) setError(loadFailed)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [hostId, scopeKey, vaultId, loadFailed, setError, setLoading, setRecord])

  const heartbeatAge = record?.lastHeartbeatAt ? Math.max(0, Date.now() - record.lastHeartbeatAt) : null
  const canOperate = Boolean(scopeKey && host && resolveAuthSecret && !running && !releaseLoading)

  async function refresh() {
    if (!host || !scopeKey || !resolveAuthSecret) return
    setLoading(true)
    setError('')
    try {
      const checked = await checkShellbeamAgent(host, resolveAuthSecret, Date.now(), vaultId)
      if (!isCurrent()) return
      const next = { ...checked.record, vaultId }
      setRecord(next)
      await upsertShellbeamAgent(next)
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  async function operate(action: 'install' | 'upgrade' | 'uninstall') {
    if (!host || !scopeKey || !resolveAuthSecret) return
    setRunning(action)
    setError('')
    try {
      if ((action === 'install' || action === 'upgrade') && selectedManifest && selectedPolicy) {
        await runShellbeamAgentArtifactOperation({
          host,
          vaultId,
          resolveAuthSecret,
          manifest: selectedManifest,
          policy: selectedPolicy,
          previousSha256: action === 'upgrade' ? release?.release.manifest.previousSha256 : undefined,
          releaseSummary: release ? shellbeamAgentReleaseParamsSummary({ release: release.release }) : undefined,
          action,
          isCurrent,
          confirmMessage: t(`workspace.agentProbe.confirm.${action}`),
          onRecord: (next) => { if (isCurrent() && next.hostId === host.id && next.vaultId === vaultId) setRecord(next) },
        })
      } else {
        if (action !== 'uninstall') throw new Error('release_catalog_not_configured')
        await runShellbeamAgentOperation({
          host,
          vaultId,
          resolveAuthSecret,
          action,
          isCurrent,
          confirmMessage: t(`workspace.agentProbe.confirm.${action}`),
          onRecord: (next) => { if (isCurrent() && next.hostId === host.id && next.vaultId === vaultId) setRecord(next) },
        })
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) setRunning(null)
    }
  }

  async function loadRelease() {
    if (!host || !scopeKey || !resolveAuthSecret) return
    setReleaseLoading(true)
    setError('')
    try {
      const settings = loadShellbeamAgentReleaseSettings()
      const selected = await loadShellbeamAgentCatalogRelease({ host, vaultId, resolveAuthSecret, currentVersion: record?.version, settings })
      if (!isCurrent()) return
      setReleaseState({ key: scopeToken, vaultId, hostId: host.id, release: selected, policy: { allowedHosts: settings.artifactAllowedHosts, trustedPublicKeyBase64: settings.artifactTrustedPublicKeyBase64 } })
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (isCurrent()) setReleaseLoading(false) }
  }

  if (!host || !scopeKey) return null
  const inactive = record?.status === 'not-installed' || record?.status === 'retired' || record?.status === 'unsupported'
  const needsAttention = !inactive && (record?.status === 'failed' || record?.status === 'offline'
    || record?.health === 'offline' || record?.health === 'stale' || Boolean(record?.lastError)
    || (record?.status === 'installed' && heartbeatAge !== null && heartbeatAge > record.heartbeatTtlMs))
  const heartbeatLabel = heartbeatAge === null ? t('workspace.agentProbe.never') : record?.health === 'online' && heartbeatAge <= (record?.heartbeatTtlMs ?? SHELLBEAM_AGENT_HEARTBEAT_TTL_MS) ? t('workspace.agentProbe.online') : record?.health === 'offline' || record?.health === 'stale' ? t('workspace.agentProbe.offline') : t('workspace.agentProbe.unknown')
  if (variant === 'card') {
    const tile = (label: string, value: string, tone = '') => <div className="min-w-0 rounded-md bg-[var(--workspace-surface-800)] px-2.5 py-1.5"><div className="truncate text-[10.5px] text-[var(--workspace-text-muted)]">{label}</div><div className={`mt-0.5 truncate text-[13px] font-semibold ${tone || 'text-[var(--workspace-text-strong)]'}`}>{value}</div></div>
    const note = 'flex items-start gap-1.5 text-[11.5px] leading-5 text-[var(--workspace-text-muted)]'
    return (
      <section data-testid="shellbeam-agent-panel" data-variant="card" className={`sb-card flex min-w-0 flex-col ${className ?? ''}`}>
        <div className="flex items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
          <h3 className="truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.agentProbe.title')}</h3>
          <button type="button" onClick={() => void refresh()} disabled={!resolveAuthSecret || loading || Boolean(running)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-nav-hover-bg)] disabled:opacity-50">
            <ScanSearch className={`h-3.5 w-3.5 ${loading ? 'animate-pulse' : ''}`} aria-hidden="true" />{t('workspace.agentProbe.check')}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(4.75rem,1fr))] gap-1.5">
            {tile(t('workspace.agentProbe.status'), t(`workspace.agentProbe.lifecycle.${record?.status ?? 'unknown'}`), statusTone(record?.status ?? 'unknown'))}
            {tile(t('workspace.agentProbe.version'), record?.version || '—')}
            {tile(t('workspace.agentProbe.heartbeat'), heartbeatLabel)}
            {tile(t('workspace.agentProbe.capabilities'), record?.capabilities.length ? record.capabilities.join(', ') : '—')}
          </div>
          <p className={note}><BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{release ? `${t('workspace.agentProbe.releaseReady')} · ${release.release.manifest.channel} ${release.release.manifest.artifact.version} · sha256 ${release.release.manifest.artifact.sha256.slice(0, 8)}` : artifactReady ? t('workspace.agentProbe.releaseReady') : t('workspace.agentProbe.releaseMissing')}</p>
          {record?.lastError && <p className="flex items-start gap-1.5 text-[11.5px] text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{record.lastError}</p>}
          {error && <p className="flex items-start gap-1.5 text-[11.5px] text-destructive"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{error}</p>}
          <div className="flex flex-wrap items-center gap-1">
            {!artifactReady && <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => void loadRelease()} disabled={!canOperate}>{releaseLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}{t('workspace.agentProbe.releaseLoad')}</Button>}
            <Button type="button" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={!canOperate || !artifactReady || record?.status === 'installed'} onClick={() => void operate('install')}><Download className="h-3.5 w-3.5" />{t('workspace.agentProbe.install')}</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={!canOperate || !artifactReady || record?.status !== 'installed'} onClick={() => void operate('upgrade')}><Upload className="h-3.5 w-3.5" />{t('workspace.agentProbe.upgrade')}</Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={!canOperate || record?.status !== 'installed'} onClick={() => void operate('uninstall')}><Trash2 className="h-3.5 w-3.5" />{t('workspace.agentProbe.uninstall')}</Button>
            <span className="flex-1" />
            <details className="group relative">
              <summary title={t('workspace.agentProbe.commandPreview')} aria-label={t('workspace.agentProbe.commandPreview')} className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] [&::-webkit-details-marker]:hidden"><CodeXml className="h-3.5 w-3.5" aria-hidden="true" /></summary>
              <div className="absolute bottom-8 right-0 z-20 w-[22rem] rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3 text-xs shadow-lg">
                <p className="leading-5 text-[var(--workspace-text-muted)]">{t('workspace.agentProbe.runtimeNote')}</p>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">{['install', 'upgrade', 'uninstall'].map((action) => buildShellbeamAgentPlan(action as 'install' | 'upgrade' | 'uninstall').command).join('\n')}</pre>
              </div>
            </details>
          </div>
          <p className={note}><Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('workspace.agentProbe.permissionNote')}{record?.transport === 'proxy-jump' ? ` · ${t('workspace.agentProbe.proxyJump')}` : ''}</p>
        </div>
      </section>
    )
  }
  if (!expanded) return <div data-testid="shellbeam-agent-entry" className="flex flex-wrap items-center gap-3 text-xs">
    <button type="button" aria-expanded="false" onClick={() => setExpandedScope(scopeToken)} className="rounded border border-border/60 px-3 py-1.5 text-muted-foreground hover:text-foreground">
      {record ? copy.manageAgent : copy.monitoringTools}
    </button>
    {needsAttention && <span role="status" className="text-[color:var(--workspace-status-warn-text)]">{copy.agentAttention}</span>}
    {error && <span role="status" className="text-[color:var(--workspace-status-warn-text)]">{error}</span>}
  </div>

  return (
    <section data-testid="shellbeam-agent-panel" className="rounded-xl border border-border/60 bg-card px-5 py-4">
      <button type="button" aria-expanded="true" onClick={() => setExpandedScope(null)} className="mb-3 text-xs text-muted-foreground hover:text-foreground">{copy.closeAgent}</button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="h-4 w-4" /></div>
          <div>
            <div className="text-sm font-semibold">{t('workspace.agentProbe.title')}</div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{t('workspace.agentProbe.description')}</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()} disabled={!resolveAuthSecret || loading || Boolean(running)}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{t('workspace.agentProbe.check')}
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('workspace.agentProbe.status')}</div>
          <div className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${statusTone(record?.status ?? 'unknown')}`}>
            {record?.status === 'installed' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />}
            {t(`workspace.agentProbe.lifecycle.${record?.status ?? 'unknown'}`)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('workspace.agentProbe.version')}</div>
          <div className="mt-1 text-sm font-medium">{record?.version || t('workspace.agentProbe.unknown')}</div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('workspace.agentProbe.heartbeat')}</div>
          <div className="mt-1 text-sm font-medium">{heartbeatAge === null ? t('workspace.agentProbe.never') : record?.health === 'online' && heartbeatAge <= (record?.heartbeatTtlMs ?? SHELLBEAM_AGENT_HEARTBEAT_TTL_MS) ? t('workspace.agentProbe.online') : record?.health === 'offline' || record?.health === 'stale' ? t('workspace.agentProbe.offline') : t('workspace.agentProbe.unknown')}</div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('workspace.agentProbe.capabilities')}</div>
          <div className="mt-1 truncate text-sm font-medium">{record?.capabilities.length ? record.capabilities.join(', ') : t('workspace.agentProbe.none')}</div>
        </div>
      </div>

      <ShellbeamAgentHistoryView vaultId={vaultId} hostId={host.id} nodeId={record?.agentId} />

      {record?.lastError && <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{record.lastError}</div>}
      {record?.transport === 'proxy-jump' && <div className="mt-3 text-xs text-muted-foreground">{t('workspace.agentProbe.proxyJump')}</div>}
      {error && <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
        {artifactReady ? t('workspace.agentProbe.artifactVerified') : t('workspace.agentProbe.releaseMissing')}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void loadRelease()} disabled={!canOperate}>{releaseLoading ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />}{t('workspace.agentProbe.releaseLoad')}</Button>
        {release && <span className="text-xs text-muted-foreground">{t('workspace.agentProbe.releaseReady')}: {release.release.manifest.channel} / {release.release.manifest.artifact.version} / {release.release.manifest.artifact.sha256.slice(0, 12)}</span>}
      </div>
      <details className="mt-3 rounded-lg border border-border/50 p-3 text-xs">
        <summary className="cursor-pointer font-medium">{t('workspace.agentProbe.commandPreview')}</summary>
        <p className="mt-2 leading-5 text-muted-foreground">{t('workspace.agentProbe.runtimeNote')}</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all">{['install', 'upgrade', 'uninstall'].map((action) => buildShellbeamAgentPlan(action as 'install' | 'upgrade' | 'uninstall').command).join('\n')}</pre>
      </details>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!canOperate || !artifactReady || record?.status === 'installed'} onClick={() => void operate('install')}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />{t('workspace.agentProbe.install')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!canOperate || !artifactReady || record?.status !== 'installed'} onClick={() => void operate('upgrade')}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />{t('workspace.agentProbe.upgrade')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!canOperate || record?.status !== 'installed'} onClick={() => void operate('uninstall')}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('workspace.agentProbe.uninstall')}
        </Button>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">{t('workspace.agentProbe.permissionNote')}</p>
    </section>
  )
}
