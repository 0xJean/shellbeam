import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import { runSshCommand } from '@/lib/sessions'
import {
  DEFAULT_WORKSPACE_METRICS,
  parseWorkspaceMetrics,
  WORKSPACE_METRICS_COMMAND,
  type WorkspaceMetrics,
} from '@/lib/workspace-metrics'

interface WorkspaceStatusCardsProps {
  hostAddress: string
  selectedHostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
}

const STATUS_CARDS = [
  { key: 'cpu', labelKey: 'workspace.status.cpu', accent: 'from-sky-400 to-blue-600' },
  { key: 'memory', labelKey: 'workspace.status.memory', accent: 'from-emerald-400 to-green-600' },
  { key: 'disk', labelKey: 'workspace.status.disk', accent: 'from-amber-400 to-orange-500' },
  { key: 'network', labelKey: 'workspace.status.network', accent: 'from-violet-400 to-indigo-600' },
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
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const host = useMemo(
    () => hosts.find((entry) => entry.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )

  useEffect(() => {
    if (!host || !resolveAuthSecret) {
      setMetrics(DEFAULT_WORKSPACE_METRICS)
      return
    }

    const currentHost = host
    const currentResolveAuthSecret = resolveAuthSecret
    let cancelled = false

    async function loadMetrics() {
      setLoading(true)

      try {
        const secret = await currentResolveAuthSecret(currentHost)
        const result = await runSshCommand({
          hostId: currentHost.id,
          host: currentHost.address,
          port: currentHost.port || 22,
          username: currentHost.username || 'root',
          authType: currentHost.authType,
          password: currentHost.authType === 'password' ? secret : undefined,
          privateKey: currentHost.authType === 'privateKey' ? secret : undefined,
          command: WORKSPACE_METRICS_COMMAND,
        })

        if (!cancelled) {
          setMetrics(parseWorkspaceMetrics([result.stdout, result.stderr].filter(Boolean).join('\n')))
          setUpdatedAt(Date.now())
        }
      } catch {
        if (!cancelled) {
          setMetrics(DEFAULT_WORKSPACE_METRICS)
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
          const primaryValue = value ? (card.key === 'network' ? value : `${value}%`) : t('workspace.statusValue.notConnected')

          return (
            <div
              key={card.labelKey}
              data-testid="workspace-status-card"
              className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-card p-4 shadow-[0_12px_24px_rgba(15,23,42,0.05)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{t(card.labelKey)}</div>
                <div className={`h-2.5 w-2.5 rounded-full bg-gradient-to-br ${card.accent} ${loading ? 'animate-pulse' : ''}`} />
              </div>
              <div className="mt-4 flex min-w-0 items-end justify-between gap-3">
                <div className="min-w-0 text-[clamp(1.5rem,3vw,1.875rem)] font-semibold leading-none tracking-tight">
                  <div className="truncate">{primaryValue}</div>
                </div>
                <div className="min-w-0 max-w-[42%] text-right text-[11px] text-muted-foreground">
                  <div className="truncate">{hostAddress}</div>
                  <div>{updatedAt ? t('workspace.statusValue.live') : t('workspace.statusValue.notConnected')}</div>
                </div>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/70">
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${card.accent} transition-[width] duration-500`}
                  style={{ width: `${percent ?? (value ? 72 : 18)}%` }}
                />
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                {card.key === 'network'
                  ? t('workspace.statusHint.network')
                  : t('workspace.statusHint.percent')}
              </div>
            </div>
          )
        })()
      ))}
    </div>
  )
}
