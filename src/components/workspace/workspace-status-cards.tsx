import type { HostProfile } from '@/lib/hosts'
import { resolveWorkspaceMetricsHost } from '@/lib/workspace-metrics'
import { useServerMonitorStates } from '@/lib/server-monitor-state'
import { getServerMonitorHostKey, type ServerMonitorSnapshot, type ServerMonitorStatus } from '@/lib/server-monitor'
import { t } from '@/lib/i18n'
import { listPersistedProbeSnapshots } from '@/lib/probe-persistence'
import type { ProbeProviderTelemetry } from '@/lib/probe-provider'
import { ShellbeamAgentPanel } from './shellbeam-agent-panel'
import { useEffect, useState } from 'react'
import { COLLECTION_LIMITS } from '@/lib/collection-limits'

interface WorkspaceStatusCardsProps {
  activeVaultId?: string
  hostAddress: string
  selectedHostId?: string | null
  hosts?: HostProfile[]
  /** Kept for call-site compatibility. Sampling is owned by the app-level runtime. */
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
}

const STATUS_CARDS = [
  { key: 'cpu', labelKey: 'workspace.status.cpu', accent: 'from-[var(--workspace-metric-cpu-from)] to-[var(--workspace-metric-cpu-to)]', glow: 'bg-[var(--workspace-metric-cpu-glow)]' },
  { key: 'memory', labelKey: 'workspace.status.memory', accent: 'from-[var(--workspace-metric-memory-from)] to-[var(--workspace-metric-memory-to)]', glow: 'bg-[var(--workspace-metric-memory-glow)]' },
  { key: 'disk', labelKey: 'workspace.status.disk', accent: 'from-[var(--workspace-metric-disk-from)] to-[var(--workspace-metric-disk-to)]', glow: 'bg-[var(--workspace-metric-disk-glow)]' },
  { key: 'network', labelKey: 'workspace.status.network', accent: 'from-[var(--workspace-metric-network-from)] to-[var(--workspace-metric-network-to)]', glow: 'bg-[var(--workspace-metric-network-glow)]' },
] as const

function formatBytesPerSecond(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let next = Math.max(0, value)
  let index = 0
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${next >= 10 || index === 0 ? Math.round(next) : next.toFixed(1)} ${units[index]}`
}

function statusLabel(status: ServerMonitorStatus | undefined) {
  if (status === 'unsupported') return t('workspace.monitor.status.unsupported')
  if (status === 'online') return t('workspace.monitor.status.online')
  if (status === 'stale') return t('workspace.monitor.status.stale')
  if (status === 'offline') return t('workspace.monitor.status.offline')
  if (status === 'paused') return t('workspace.monitor.status.paused')
  return t('workspace.monitor.status.checking')
}

function statusTone(status: ServerMonitorStatus | undefined) {
  if (status === 'unsupported') return 'idle'
  if (status === 'online') return 'online'
  if (status === 'stale') return 'stale'
  if (status === 'offline') return 'offline'
  if (status === 'paused') return 'paused'
  return 'checking'
}

function getCardValue(key: (typeof STATUS_CARDS)[number]['key'], snapshot: ServerMonitorSnapshot | null) {
  if (!snapshot) return { value: null, percent: null }
  if (key !== 'network') {
    const value = snapshot[key === 'cpu' ? 'cpuPercent' : key === 'memory' ? 'memoryPercent' : 'diskPercent']
    return value == null || !Number.isFinite(value) ? { value: null, percent: null } : { value: `${Math.round(value)}%`, percent: value }
  }
  const rx = formatBytesPerSecond(snapshot.networkRxBytesPerSec)
  const tx = formatBytesPerSecond(snapshot.networkTxBytesPerSec)
  if (!rx && !tx) return { value: null, percent: null }
  return { value: `↓ ${rx ?? '--'} · ↑ ${tx ?? '--'}`, percent: null }
}

export function WorkspaceStatusCards(props: WorkspaceStatusCardsProps) {
  const { hostAddress, selectedHostId = null, hosts = [] } = props
  const monitorStates = useServerMonitorStates()
  const host = resolveWorkspaceMetricsHost(hosts, { selectedHostId, hostAddress, vaultId: props.activeVaultId })
  const monitor = host ? monitorStates[getServerMonitorHostKey(host)] : undefined
  const latest = monitor?.latest
  const snapshot = latest?.snapshot ?? null
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  // A persisted online flag cannot keep an old sample live indefinitely. The
  // monitor explicitly samples SSH metrics; unrelated inventory updates never
  // extend this collector's freshness budget.
  const sampleTime = snapshot?.sampledAt
  const validSample = typeof sampleTime === 'number' && Number.isFinite(sampleTime) && sampleTime > 0 && sampleTime <= now
  const status = latest?.status === 'online'
    ? !validSample ? 'checking' : now - sampleTime > COLLECTION_LIMITS.cadence.metricsTtlMs ? 'stale' : 'online'
    : latest?.status
  const telemetryKey = props.activeVaultId && host?.id ? `${props.activeVaultId}:${host.id}` : null
  const [persistedTelemetryState, setPersistedTelemetryState] = useState<{ key: string; telemetry: ProbeProviderTelemetry | null } | null>(null)

  useEffect(() => {
    let active = true
    if (!telemetryKey || !props.activeVaultId || !host?.id) return () => { active = false }
    void listPersistedProbeSnapshots({ vaultId: props.activeVaultId, hostId: host.id })
      .then((rows) => {
        if (!active) return
        const telemetry = [...rows]
          .sort((left, right) => (right.updatedAt || right.receivedAt) - (left.updatedAt || left.receivedAt))
          .map((row) => row.snapshot.telemetry ?? null)
          .find((value): value is ProbeProviderTelemetry => value !== null)
        setPersistedTelemetryState({ key: telemetryKey, telemetry: telemetry ?? null })
      })
      .catch(() => {
        if (active) setPersistedTelemetryState({ key: telemetryKey, telemetry: null })
      })
    return () => { active = false }
  }, [host?.id, props.activeVaultId, telemetryKey])

  const persistedTelemetry = persistedTelemetryState?.key === telemetryKey ? persistedTelemetryState.telemetry : null
  const probeTelemetry = latest?.probeTelemetry ?? persistedTelemetry

  return (
    <>
      <div
        data-testid="workspace-status-grid"
        className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3"
      >
        {STATUS_CARDS.map((card) => {
        const metric = getCardValue(card.key, snapshot)
        const primaryValue = metric.value
          ?? (latest ? t('workspace.statusValue.unavailable') : t('workspace.statusValue.notConnected'))
        const label = latest ? statusLabel(status) : t('workspace.statusValue.notConnected')
        const tone = latest ? statusTone(status) : 'idle'
        const sampledAt = snapshot?.sampledAt ?? latest?.lastSuccessAt ?? null

        return (
          <div
            key={card.labelKey}
            data-testid="workspace-status-card"
            data-status={tone}
            className={`min-w-0 overflow-hidden rounded-xl border bg-[var(--workspace-surface-900)] p-4 text-[var(--workspace-text)] shadow-[var(--workspace-shadow-card)] ${
              tone === 'offline'
                ? 'border-[color:var(--workspace-status-bad-border)]'
                : tone === 'stale' || tone === 'paused'
                  ? 'border-[color:var(--workspace-status-warn-border)]'
                  : 'border-[color:var(--workspace-border-soft)]'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--workspace-text-subtle)]">{t(card.labelKey)}</div>
                <div className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                  {card.key === 'network'
                    ? t('workspace.statusHint.network')
                    : t('workspace.statusHint.percent')}
                </div>
              </div>
              <div className={`flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--workspace-border-soft)] ${card.glow}`}>
                <div className={`h-2.5 w-2.5 rounded-full bg-gradient-to-br ${card.accent} ${tone === 'checking' ? 'animate-pulse' : ''}`} />
              </div>
            </div>
            <div className="mt-4 flex min-w-0 items-end justify-between gap-3">
              <div className="min-w-0 text-[clamp(1.5rem,3vw,1.875rem)] font-semibold leading-none tracking-tight text-[var(--workspace-text-strong)]">
                <div className="truncate">{primaryValue}</div>
              </div>
              <div className="min-w-0 max-w-[42%] text-right text-[11px] text-[var(--workspace-text-muted)]">
                <div className="truncate">{hostAddress}</div>
                <div>{label}</div>
              </div>
            </div>
            <div
              data-testid="workspace-status-meter"
              className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--workspace-surface-950)]"
            >
              <div
                className={`h-full rounded-full bg-gradient-to-r ${card.accent} transition-[width] duration-500`}
                style={{ width: `${metric.percent ?? (metric.value ? 72 : 18)}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--workspace-text-subtle)]">
              <span>{latest ? label : t('workspace.statusValue.notConnected')}</span>
              <span>{sampledAt ? new Date(sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</span>
            </div>
            {probeTelemetry && (
              <div
                data-testid="workspace-probe-telemetry"
                className="mt-2 truncate text-[10px] text-[var(--workspace-text-subtle)]"
                title={t('workspace.probeTelemetry.title')}
              >
                {t(`workspace.probeTelemetry.status.${probeTelemetry.status}`)}
                {' · '}
                {t('workspace.probeTelemetry.attempts', { count: probeTelemetry.attempts })}
                {' · '}
                {t('workspace.probeTelemetry.duration', { ms: probeTelemetry.durationMs })}
              </div>
            )}
          </div>
        )
        })}
      </div>
      <div className="mt-4">
        <ShellbeamAgentPanel host={host ?? null} vaultId={props.activeVaultId} resolveAuthSecret={props.resolveAuthSecret} />
      </div>
    </>
  )
}
