import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import {
  DEFAULT_WORKSPACE_METRICS,
  fetchWorkspaceMetrics,
  resolveWorkspaceMetricsHost,
  type WorkspaceMetrics,
} from '@/lib/workspace-metrics'

interface WorkspaceStatusCardsProps {
  hostAddress: string
  selectedHostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
}

const STATUS_CARDS = [
  { key: 'cpu', labelKey: 'workspace.status.cpu', accent: 'from-[#58b2ff] to-[var(--workspace-primary-500)]', glow: 'bg-[rgba(19,127,236,0.14)]' },
  { key: 'memory', labelKey: 'workspace.status.memory', accent: 'from-[#4ade80] to-[#15803d]', glow: 'bg-[rgba(34,197,94,0.12)]' },
  { key: 'disk', labelKey: 'workspace.status.disk', accent: 'from-[#fbbf24] to-[#ea580c]', glow: 'bg-[rgba(245,158,11,0.12)]' },
  { key: 'network', labelKey: 'workspace.status.network', accent: 'from-[#7dd3fc] to-[#2563eb]', glow: 'bg-[rgba(56,189,248,0.12)]' },
]

function normalizePercent(value: string) {
  const numeric = Number.parseFloat(value)
  if (Number.isNaN(numeric)) return null
  return Math.max(0, Math.min(100, numeric))
}

export function WorkspaceStatusCards({
  hostAddress,
  selectedHostId = null,
  hosts = [],
  resolveAuthSecret,
}: WorkspaceStatusCardsProps) {
  const [metrics, setMetrics] = useState<WorkspaceMetrics>(DEFAULT_WORKSPACE_METRICS)
  const [loading, setLoading] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const host = useMemo(
    () => resolveWorkspaceMetricsHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )

  useEffect(() => {
    if (!host || !resolveAuthSecret) {
      setMetrics(DEFAULT_WORKSPACE_METRICS)
      setUpdatedAt(null)
      setUnreachable(false)
      setLoading(false)
      return
    }

    const currentHost = host
    const currentResolveAuthSecret = resolveAuthSecret
    let cancelled = false

    async function loadMetrics() {
      setLoading(true)

      try {
        const nextMetrics = await fetchWorkspaceMetrics({
          host: currentHost,
          resolveAuthSecret: currentResolveAuthSecret,
        })
        if (!cancelled) {
          setMetrics(nextMetrics)
          setUpdatedAt(Date.now())
          setUnreachable(false)
        }
      } catch {
        if (!cancelled) {
          setMetrics(DEFAULT_WORKSPACE_METRICS)
          setUpdatedAt(null)
          setUnreachable(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadMetrics()
    const intervalId = window.setInterval(() => {
      void loadMetrics()
    }, 15000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [host, resolveAuthSecret])

  return (
    <div
      data-testid="workspace-status-grid"
      className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3"
    >
      {STATUS_CARDS.map((card) => (
        (() => {
          const value = metrics[card.key as keyof WorkspaceMetrics]
          const percent = card.key === 'network' ? null : normalizePercent(value)
          const primaryValue = value
            ? (card.key === 'network' ? value : `${value}%`)
            : unreachable
              ? t('workspace.statusValue.unreachable')
              : updatedAt
                ? t('workspace.statusValue.unavailable')
                : t('workspace.statusValue.notConnected')
          const connectionLabel = unreachable
            ? t('workspace.statusValue.unreachable')
            : updatedAt
              ? t('workspace.statusValue.live')
              : t('workspace.statusValue.notConnected')

          return (
            <div
              key={card.labelKey}
              data-testid="workspace-status-card"
              data-status={unreachable ? 'unreachable' : updatedAt ? 'live' : 'idle'}
              className={`min-w-0 overflow-hidden rounded-xl border bg-[var(--workspace-surface-900)] p-4 text-[var(--workspace-text)] shadow-[0_4px_6px_-1px_rgba(0,0,0,0.3)] ${
                unreachable ? 'border-red-500/30' : 'border-[color:var(--workspace-border-strong)]'
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
                <div className={`flex h-9 w-9 items-center justify-center rounded-full border border-white/10 ${card.glow}`}>
                  <div className={`h-2.5 w-2.5 rounded-full bg-gradient-to-br ${card.accent} ${loading ? 'animate-pulse' : ''}`} />
                </div>
              </div>
              <div className="mt-4 flex min-w-0 items-end justify-between gap-3">
                <div className="min-w-0 text-[clamp(1.5rem,3vw,1.875rem)] font-semibold leading-none tracking-tight text-[var(--workspace-text-strong)]">
                  <div className="truncate">{primaryValue}</div>
                </div>
                <div className="min-w-0 max-w-[42%] text-right text-[11px] text-[var(--workspace-text-muted)]">
                  <div className="truncate">{hostAddress}</div>
                  <div>{connectionLabel}</div>
                </div>
              </div>
              <div
                data-testid="workspace-status-meter"
                className="mt-4 h-1.5 overflow-hidden rounded-full bg-[rgba(8,15,22,0.9)]"
              >
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${card.accent} transition-[width] duration-500`}
                  style={{ width: `${percent ?? (value ? 72 : 18)}%` }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--workspace-text-subtle)]">
                <span>{unreachable ? t('workspace.statusValue.unreachable') : loading ? t('workspace.statusValue.live') : t('workspace.desktop.ready')}</span>
                <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</span>
              </div>
            </div>
          )
        })()
      ))}
    </div>
  )
}
