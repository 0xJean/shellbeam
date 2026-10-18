import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
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
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, RefreshCw, ShieldAlert, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

interface ShellbeamAgentPanelProps {
  host: HostProfile | null
  vaultId?: string
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  /** Optional embedded trusted artifact for controlled distributions. The
   * production panel loads signed release catalogs from saved release policy. */
  artifactManifest?: unknown
  artifactPolicy?: ShellbeamAgentArtifactPolicy
}

function statusTone(status: ShellbeamAgentRecord['status']) {
  if (status === 'installed') return 'text-[color:var(--workspace-status-good-text)]'
  if (status === 'offline' || status === 'failed') return 'text-[color:var(--workspace-status-bad-text)]'
  if (status === 'unsupported') return 'text-[color:var(--workspace-status-warn-text)]'
  return 'text-[var(--workspace-text-muted)]'
}

export function ShellbeamAgentPanel({ host, vaultId = 'local', resolveAuthSecret, artifactManifest, artifactPolicy }: ShellbeamAgentPanelProps) {
  const { t } = useT()
  const [storedRecord, setRecord] = useState<ShellbeamAgentRecord | null>(null)
  const record = storedRecord?.hostId === host?.id ? storedRecord : null
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState<'install' | 'upgrade' | 'uninstall' | null>(null)
  const [error, setError] = useState('')
  const [releaseLoading, setReleaseLoading] = useState(false)
  const [releaseState, setReleaseState] = useState<{ hostId: string; release: ValidatedShellbeamAgentRelease; policy: ShellbeamAgentArtifactPolicy } | null>(null)
  const release = releaseState?.hostId === host?.id ? releaseState : null
  const selectedManifest = release?.release.manifest.artifact ?? artifactManifest
  const selectedPolicy = release?.policy ?? artifactPolicy
  const artifactReady = Boolean(selectedManifest && selectedPolicy)

  useEffect(() => {
    let cancelled = false
    if (!host) {
      setRecord(null)
      return
    }
    setLoading(true)
    void listShellbeamAgents({ vaultId, hostId: host.id }).then((records) => {
      if (!cancelled) setRecord(records[0] ?? null)
    }).catch(() => {
      if (!cancelled) setError(t('workspace.agentProbe.loadFailed'))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [host, t, vaultId])

  const heartbeatAge = useMemo(() => {
    if (!record?.lastHeartbeatAt) return null
    return Math.max(0, Date.now() - record.lastHeartbeatAt)
  }, [record])
  const canOperate = Boolean(host && resolveAuthSecret && !running && !releaseLoading)

  async function refresh() {
    if (!host || !resolveAuthSecret) return
    setLoading(true)
    setError('')
    try {
      const checked = await checkShellbeamAgent(host, resolveAuthSecret, Date.now(), vaultId)
      const next = { ...checked.record, vaultId }
      setRecord(next)
      await upsertShellbeamAgent(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function operate(action: 'install' | 'upgrade' | 'uninstall') {
    if (!host || !resolveAuthSecret) return
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
          confirmMessage: t(`workspace.agentProbe.confirm.${action}`),
          onRecord: setRecord,
        })
      } else {
        if (action !== 'uninstall') throw new Error('release_catalog_not_configured')
        await runShellbeamAgentOperation({
          host,
          vaultId,
          resolveAuthSecret,
          action,
          confirmMessage: t(`workspace.agentProbe.confirm.${action}`),
          onRecord: setRecord,
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(null)
    }
  }

  async function loadRelease() {
    if (!host || !resolveAuthSecret) return
    setReleaseLoading(true)
    setError('')
    try {
      const settings = loadShellbeamAgentReleaseSettings()
      const selected = await loadShellbeamAgentCatalogRelease({ host, vaultId, resolveAuthSecret, currentVersion: record?.version, settings })
      setReleaseState({ hostId: host.id, release: selected, policy: { allowedHosts: settings.artifactAllowedHosts, trustedPublicKeyBase64: settings.artifactTrustedPublicKeyBase64 } })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setReleaseLoading(false) }
  }

  if (!host) return null

  return (
    <section data-testid="shellbeam-agent-panel" className="rounded-xl border border-border/60 bg-card px-5 py-4">
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
          <div className="mt-1 text-sm font-medium">{heartbeatAge === null ? t('workspace.agentProbe.never') : heartbeatAge <= (record?.heartbeatTtlMs ?? SHELLBEAM_AGENT_HEARTBEAT_TTL_MS) ? t('workspace.agentProbe.online') : t('workspace.agentProbe.offline')}</div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('workspace.agentProbe.capabilities')}</div>
          <div className="mt-1 truncate text-sm font-medium">{record?.capabilities.length ? record.capabilities.join(', ') : t('workspace.agentProbe.none')}</div>
        </div>
      </div>

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
