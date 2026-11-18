import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDownUp,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Layers,
  PlugZap,
  Radar,
  RefreshCw,
  Server,
  Settings2,
  Siren,
  Wrench,
  X,
} from 'lucide-react'
import {
  BarList,
  CHART_COLORS,
  ChartCard,
  ChartLegend,
  DonutChart,
  DonutLegend,
  Heatmap,
  ScatterChart,
  SegmentedTabs,
  Sparkline,
  StackedBarChart,
  STATUS_COLORS,
  TimeSeriesChart,
} from '@/components/charts/chart-primitives'
import { HostRegionMeta } from '@/components/host-display-meta'
import { HostProbeManageDialog } from '@/components/host-probe-manage-dialog'
import { InlineServerConnect } from '@/components/inline-server-connect'
import { MonitorSettingsSection } from '@/components/monitor-settings-section'
import { ProbeBatchInstallDialog } from '@/components/probe-batch-install'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useFleetMetrics, isOpenAlert, type FleetHost } from '@/hooks/use-fleet-metrics'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fleetDashboardCopy } from '@/lib/locales/fleet-dashboard'
import { fill } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import {
  averageBuckets,
  bucketize,
  bucketTimes,
  dailyAlertCounts,
  DAY_MS,
  formatBytes,
  formatBytesRate,
  latestValue,
  mean,
  peak,
  seriesOf,
  sumBuckets,
  type NumericMetric,
} from '@/lib/metric-series'
import { isProbeInstalled, isProbeSupportedOs } from '@/lib/probe-install'
import { cn } from '@/lib/utils'
import { vaultGetSecret, vaultSetSecret } from '@/lib/vault'

type Tab = 'resources' | 'probes' | 'ops' | 'assets'
type Range = 1 | 24 | 168
const RANGE_BUCKETS: Record<Range, number> = { 1: 60, 24: 48, 168: 84 }
const HEAT_COLUMNS: Record<Range, number> = { 1: 12, 24: 24, 168: 28 }

interface FleetDashboardProps {
  hosts: HostProfile[]
  vaultId?: string | null
  unlocked: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  /** Opens the host's workspace on its monitoring charts. */
  onOpenHost?: (hostId: string) => void
  onOpenAlerts?: () => void
}

function bucketOf(item: FleetHost): 'online' | 'attention' | 'offline' | 'checking' {
  if (item.status === 'offline' || item.status === 'jump-unavailable') return 'offline'
  if (item.openAlerts > 0 || item.status === 'stale') return 'attention'
  if (item.status === 'online') return 'online'
  return 'checking'
}

const latestMetric = (item: FleetHost, metric: NumericMetric) => {
  const live = item.view?.metrics?.[metric] as number | null | undefined
  if (live != null) return live
  return latestValue(seriesOf(item.history, metric))
}

const osFamily = (os: string | null | undefined) => {
  const name = (os ?? '').trim().split(/[\s/]+/)[0]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : ''
}

const hostOsString = (item: FleetHost) =>
  item.view?.resource?.os || item.view?.metrics?.os || item.history[item.history.length - 1]?.metrics.os || ''

export function FleetDashboard({
  hosts,
  vaultId,
  unlocked,
  onSaveToVault,
  onLoadVaultSecret,
  onOpenHost,
  onOpenAlerts,
}: FleetDashboardProps) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const u = unifiedProbeCopy[locale]
  const [tab, setTab] = useState<Tab>('resources')
  const [range, setRange] = useState<Range>(24)
  const [connectServerOpen, setConnectServerOpen] = useState(false)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [batchInstallOpen, setBatchInstallOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<HostProfile | null>(null)
  const [manageTarget, setManageTarget] = useState<HostProfile | null>(null)

  const fleet = useFleetMetrics({ hosts, vaultId, unlocked, rangeHours: range })
  const network = useHostNetworkMetadata(hosts.map((host) => host.address))

  const saveSecret = onSaveToVault ?? (async (key: string, value: string) => { await vaultSetSecret(key, value, vaultId ?? undefined) })
  const loadSecret = onLoadVaultSecret ?? (async (key: string) => vaultGetSecret(key, vaultId ?? undefined))

  const buckets = RANGE_BUCKETS[range]
  const times = useMemo(() => bucketTimes(fleet.from, fleet.to, buckets), [fleet.from, fleet.to, buckets])
  const formatTime = (time: number) => range === 168
    ? new Date(time).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
    : new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const perHost = useMemo(() => fleet.hosts.map((item) => ({
    item,
    cpu: bucketize(seriesOf(item.history, 'cpuPercent'), fleet.from, fleet.to, buckets),
    rx: bucketize(seriesOf(item.history, 'networkRxBytesPerSec'), fleet.from, fleet.to, buckets),
    tx: bucketize(seriesOf(item.history, 'networkTxBytesPerSec'), fleet.from, fleet.to, buckets),
  })), [fleet.hosts, fleet.from, fleet.to, buckets])

  const counts = { online: 0, attention: 0, offline: 0, checking: 0 }
  for (const item of fleet.hosts) counts[bucketOf(item)] += 1
  const reachable = fleet.hosts.filter((item) => bucketOf(item) !== 'offline' && bucketOf(item) !== 'checking').length
  const stale = fleet.hosts.filter((item) => item.status === 'stale').length
  const openAlerts = fleet.alerts.filter(isOpenAlert)
  const alertDays = dailyAlertCounts(fleet.alerts, 7, fleet.to || undefined)
  const dayTotal = (row: (typeof alertDays)[number]) => row.info + row.warning + row.critical
  const alertDelta = dayTotal(alertDays[6]) - dayTotal(alertDays[5])
  const cpuNow = fleet.hosts.map((item) => ({ item, value: latestMetric(item, 'cpuPercent') })).filter((row): row is { item: FleetHost; value: number } => row.value != null)
  const cpuPeak = cpuNow.reduce<{ item: FleetHost; value: number } | null>((best, row) => !best || row.value > best.value ? row : best, null)
  const clusterCpu = averageBuckets(perHost.map((row) => row.cpu))
  const rxSum = sumBuckets(perHost.map((row) => row.rx))
  const txSum = sumBuckets(perHost.map((row) => row.tx))
  const rxNow = fleet.hosts.reduce((sum, item) => sum + (latestMetric(item, 'networkRxBytesPerSec') ?? 0), 0)
  const txNow = fleet.hosts.reduce((sum, item) => sum + (latestMetric(item, 'networkTxBytesPerSec') ?? 0), 0)
  const hasNet = fleet.hosts.some((item) => latestMetric(item, 'networkRxBytesPerSec') != null)

  const probedCount = fleet.hosts.filter((item) => isProbeInstalled(item.probeRecord)).length
  const upgradeableHosts = useMemo(
    () =>
      fleet.hosts
        .filter((item) => !isProbeInstalled(item.probeRecord) && hasSshConnection(item.host) && isProbeSupportedOs(hostOsString(item)))
        .map((item) => item.host),
    [fleet.hosts],
  )
  const primaryServer = fleet.servers[0] ?? null

  return (
    <div data-testid="fleet-dashboard" className="flex min-w-0 flex-col gap-4 text-[var(--workspace-text)]">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h1>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">
            {fill(c.summary, { total: fleet.hosts.length, online: reachable })}
            {fleet.refreshedAt && <> · {fill(c.refreshed, { time: new Date(fleet.refreshedAt).toLocaleTimeString(locale) })}</>} · {c.sources}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            size="md"
            label={c.title}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'resources', label: c.tabResources },
              { value: 'probes', label: u.tabProbes },
              { value: 'ops', label: c.tabOps },
              { value: 'assets', label: c.tabAssets },
            ]}
          />
          {tab !== 'probes' && (
            <SegmentedTabs
              size="md"
              label={c.range}
              value={String(range) as `${Range}`}
              onChange={(value) => setRange(Number(value) as Range)}
              options={([1, 24, 168] as Range[]).map((value) => ({ value: String(value) as `${Range}`, label: c.rangeLabel[value] }))}
            />
          )}
          <button
            type="button"
            aria-label={c.refresh}
            title={c.refresh}
            onClick={fleet.refresh}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
          >
            <RefreshCw className={cn('h-4 w-4', fleet.loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      {/* Unified Server & Probe Control Center Bar */}
      {unlocked && vaultId && (
        <section
          data-testid="fleet-server-bar"
          className={cn(
            'sb-card flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between',
            primaryServer ? 'border-[color:var(--workspace-border-soft)]' : 'border-dashed border-primary/40 bg-primary/5',
          )}
        >
          {primaryServer ? (
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]">
                  <span>{primaryServer.name}</span>
                  <span className="truncate font-mono text-xs font-normal text-[var(--workspace-text-muted)]">
                    {primaryServer.endpoint}
                  </span>
                  {fleet.servers.length > 1 && (
                    <span className="rounded bg-[var(--workspace-surface-800)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--workspace-text-muted)]">
                      +{fleet.servers.length - 1}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">
                  {fill(u.barCoverage, {
                    probed: probedCount,
                    total: fleet.hosts.length,
                    native: Math.max(0, fleet.hosts.length - probedCount),
                  })}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Radar className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">{u.barNoServerTitle}</div>
                <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{u.barNoServerDesc}</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {!primaryServer ? (
              <Button
                size="sm"
                data-testid="fleet-connect-server"
                onClick={() => setConnectServerOpen(true)}
                className="h-8 gap-1.5 text-xs"
              >
                <PlugZap className="h-3.5 w-3.5" />
                {u.barConnectServer}
              </Button>
            ) : (
              <>
                {tab !== 'probes' && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="fleet-open-probes-tab"
                    onClick={() => setTab('probes')}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <Radar className="h-3.5 w-3.5" />
                    {fill(u.barManageProbes, { probed: probedCount, total: fleet.hosts.length })}
                  </Button>
                )}
                {upgradeableHosts.length > 0 && (
                  <Button
                    size="sm"
                    data-testid="fleet-batch-install"
                    onClick={() => setBatchInstallOpen(true)}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    {fill(u.barBatchInstall, { count: upgradeableHosts.length })}
                  </Button>
                )}
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="fleet-server-settings"
              onClick={() => setServerSettingsOpen(true)}
              className="h-8 gap-1.5 text-xs"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {u.barServerSettings}
            </Button>
          </div>
        </section>
      )}

      <div data-testid="fleet-kpis" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Server />} label={c.kpiOnline} value={<>{reachable}<small className="text-base font-medium text-[var(--workspace-text-muted)]"> / {fleet.hosts.length}</small></>}
          sub={fill(c.kpiOnlineSub, { offline: counts.offline, stale })}
          visual={<DonutChart size={56} thickness={7} segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]} />} />
        <Kpi icon={<Siren />} label={c.kpiAlerts} onClick={onOpenAlerts} value={<span className={openAlerts.length ? 'text-[color:var(--workspace-status-warn-text)]' : undefined}>{openAlerts.length}</span>}
          sub={<>{c.kpiAlertsSub} <b className={alertDelta > 0 ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[color:var(--workspace-status-good-text)]'}>{alertDelta > 0 ? `+${alertDelta}` : alertDelta}</b></>}
          visual={<Sparkline kind="bars" color={STATUS_COLORS.warn} values={alertDays.map(dayTotal)} width={84} height={34} />} />
        <Kpi icon={<Cpu />} label={c.kpiCpu} value={mean(cpuNow.map((row) => row.value)) == null ? '—' : <>{Math.round(mean(cpuNow.map((row) => row.value))!)}<small className="text-base font-medium">%</small></>}
          sub={cpuPeak ? fill(c.kpiCpuSub, { value: Math.round(cpuPeak.value), host: cpuPeak.item.host.name }) : c.noSamples}
          visual={<Sparkline values={clusterCpu} width={96} height={34} />} />
        <Kpi icon={<ArrowDownUp />} label={c.kpiNet} value={hasNet ? formatBytesRate(rxNow + txNow) : '—'}
          sub={hasNet ? `↓ ${formatBytesRate(rxNow)} · ↑ ${formatBytesRate(txNow)}` : c.noSamples}
          visual={<Sparkline values={sumBuckets([rxSum, txSum])} color={CHART_COLORS[4]} width={96} height={34} />} />
      </div>

      {tab === 'resources' && <ResourcesTab perHost={perHost} times={times} formatTime={formatTime} range={range} counts={counts} fleet={fleet.hosts} onOpenHost={onOpenHost} />}
      {tab === 'probes' && (
        <ProbesTab
          fleet={fleet.hosts}
          upgradeableCount={upgradeableHosts.length}
          onOpenHost={onOpenHost}
          onInstall={(host) => setInstallTarget(host)}
          onManage={(host) => setManageTarget(host)}
          onBatchInstall={() => setBatchInstallOpen(true)}
        />
      )}
      {tab === 'ops' && <OpsTab fleetMetrics={fleet} times={times} formatTime={formatTime} rx={rxSum} tx={txSum} />}
      {tab === 'assets' && <AssetsTab fleetMetrics={fleet} network={network} />}

      {/* Quick Connect Server Dialog */}
      {connectServerOpen && vaultId && (
        <Dialog open={connectServerOpen} onOpenChange={setConnectServerOpen} labelledBy="fleet-connect-server-title">
          <DialogContent className="max-w-lg p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="fleet-connect-server-title" className="text-base font-semibold">{u.serverBoxTitle}</h2>
              <button type="button" aria-label="Close" onClick={() => setConnectServerOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <InlineServerConnect
              vaultId={vaultId}
              saveSecret={saveSecret}
              loadSecret={loadSecret}
              onConnected={() => {
                setConnectServerOpen(false)
                fleet.refresh()
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Unified Server & Alerts Configuration Dialog */}
      {serverSettingsOpen && (
        <Dialog open={serverSettingsOpen} onOpenChange={setServerSettingsOpen} labelledBy="fleet-server-settings-title">
          <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 md:w-[880px] md:max-w-[95vw]">
            <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 id="fleet-server-settings-title" className="text-base font-semibold">{u.serverDialogTitle}</h2>
              <button type="button" aria-label="Close" onClick={() => setServerSettingsOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <MonitorSettingsSection />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {batchInstallOpen && upgradeableHosts.length > 0 && (
        <ProbeBatchInstallDialog
          hosts={upgradeableHosts}
          open={batchInstallOpen}
          onOpenChange={(open) => {
            setBatchInstallOpen(open)
            if (!open) fleet.refresh()
          }}
        />
      )}

      {installTarget && (
        <ProbeInstallDialog
          host={hosts.find((h) => h.id === installTarget.id) ?? installTarget}
          open={!!installTarget}
          onOpenChange={(open) => {
            if (!open) {
              setInstallTarget(null)
              fleet.refresh()
            }
          }}
        />
      )}

      {manageTarget && (
        <HostProbeManageDialog
          host={hosts.find((h) => h.id === manageTarget.id) ?? manageTarget}
          open={!!manageTarget}
          onOpenChange={(open) => {
            if (!open) {
              setManageTarget(null)
              fleet.refresh()
            }
          }}
        />
      )}
    </div>
  )
}

function ProbesTab({
  fleet,
  upgradeableCount,
  onOpenHost,
  onInstall,
  onManage,
  onBatchInstall,
}: {
  fleet: FleetHost[]
  upgradeableCount: number
  onOpenHost?: (hostId: string) => void
  onInstall: (host: HostProfile) => void
  onManage: (host: HostProfile) => void
  onBatchInstall: () => void
}) {
  const { locale } = useT()
  const u = unifiedProbeCopy[locale]
  const [filter, setFilter] = useState<'all' | 'probed' | 'native' | 'attention'>('all')

  const classify = (item: FleetHost): 'probed' | 'attention' | 'native' => {
    const rec = item.probeRecord
    if (isProbeInstalled(rec)) {
      return rec?.status === 'active' && item.status !== 'offline' ? 'probed' : 'attention'
    }
    if (rec && ['prepared', 'dispatched', 'unknown', 'failed', 'migrated'].includes(rec.status)) {
      return 'attention'
    }
    return 'native'
  }

  const filterCounts = { all: fleet.length, probed: 0, native: 0, attention: 0 }
  for (const item of fleet) filterCounts[classify(item)] += 1

  const visible = fleet.filter((item) => filter === 'all' || classify(item) === filter)
  const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`)

  return (
    <section data-testid="fleet-probes-manager" className="sb-card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-[color:var(--workspace-border-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{u.probeTableTitle}</h2>
          <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{u.probeTableSub}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-lg bg-[var(--workspace-surface-800)] p-1">
            {([
              ['all', fill(u.filterAll, { count: filterCounts.all })],
              ['probed', fill(u.filterProbed, { count: filterCounts.probed })],
              ['native', fill(u.filterNative, { count: filterCounts.native })],
              ['attention', fill(u.filterAttention, { count: filterCounts.attention })],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-testid={`fleet-probes-filter-${id}`}
                onClick={() => setFilter(id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === id
                    ? 'bg-[var(--workspace-surface-950)] text-[var(--workspace-text-strong)] shadow-sm'
                    : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {upgradeableCount > 0 && (
            <Button size="sm" onClick={onBatchInstall} className="h-8 gap-1.5 text-xs">
              <Layers className="h-3.5 w-3.5" />
              {fill(u.barBatchInstall, { count: upgradeableCount })}
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="px-6 py-12 text-center text-xs text-[var(--workspace-text-muted)]">
          {u.emptyHostsForProbes}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]/50 text-[11px] font-medium text-[var(--workspace-text-muted)]">
                <th className="px-4 py-2.5">{u.colHost}</th>
                <th className="px-4 py-2.5">{u.colTier}</th>
                <th className="px-4 py-2.5">{u.colMetrics}</th>
                <th className="px-4 py-2.5 text-right">{u.colActions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--workspace-border-soft)]">
              {visible.map((item) => {
                const { host, probeRecord } = item
                const installed = isProbeInstalled(probeRecord)
                const version = probeRecord?.current?.manifest.version
                const kind = classify(item)
                const canSsh = hasSshConnection(host)
                const os = osFamily(hostOsString(item))
                const cpu = latestMetric(item, 'cpuPercent')
                const mem = latestMetric(item, 'memoryPercent')
                const disk = latestMetric(item, 'diskPercent')

                return (
                  <tr key={host.id} data-testid="fleet-probe-row" data-host-id={host.id} className="hover:bg-[var(--workspace-surface-800)]/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {onOpenHost ? (
                          <button
                            type="button"
                            onClick={() => onOpenHost(host.id)}
                            className="font-semibold text-[var(--workspace-text-strong)] hover:underline"
                          >
                            {host.name}
                          </button>
                        ) : (
                          <span className="font-semibold text-[var(--workspace-text-strong)]">{host.name}</span>
                        )}
                        {os && (
                          <span className="rounded bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[10px] text-[var(--workspace-text-muted)]">
                            {os}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                        {canSsh ? `${host.username}@${host.address}:${host.port}` : host.address || u.tierPillNoSsh}
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      {kind === 'probed' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--workspace-status-good-text)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--workspace-status-good)]" />
                          {fill(u.tierPillProbed, { version: version ? `v${version}` : '' }).trim()}
                        </span>
                      ) : kind === 'attention' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--workspace-status-warn-text)]">
                          <CircleAlert className="h-3 w-3" />
                          {u.badgeAttention}
                        </span>
                      ) : host.monitoringMode === 'server' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                          {u.tierPillServerPending}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--workspace-text-muted)]">
                          {canSsh ? u.tierPillNative : u.tierPillNoSsh}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 font-mono text-[11.5px] text-[var(--workspace-text)]">
                      CPU {fmtPct(cpu)} · MEM {fmtPct(mem)} · DISK {fmtPct(disk)}
                    </td>

                    <td className="px-4 py-3 text-right">
                      {installed || kind === 'attention' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="fleet-row-manage"
                          onClick={() => onManage(host)}
                          className="h-7 gap-1.5 text-xs"
                        >
                          <Wrench className="h-3 w-3" />
                          {u.btnManageProbe}
                        </Button>
                      ) : canSsh && isProbeSupportedOs(hostOsString(item)) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="fleet-row-install"
                          onClick={() => onInstall(host)}
                          className="h-7 gap-1.5 border-dashed border-primary/50 text-xs text-[var(--workspace-accent-text)] hover:border-solid hover:bg-primary/10"
                        >
                          <Radar className="h-3 w-3" />
                          {u.btnInstallProbe}
                        </Button>
                      ) : (
                        <span className="text-[11px] text-[var(--workspace-text-subtle)]">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Kpi({ icon, label, value, sub, visual, onClick }: { icon: ReactNode; label: string; value: ReactNode; sub: ReactNode; visual?: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('sb-card flex min-w-0 items-center gap-3 p-4 text-left', onClick && 'hover:border-[color:var(--workspace-border-strong)]')}>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)] [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}{label}</div>
      <div className="mt-2 text-[28px] font-bold leading-none tracking-tight text-[var(--workspace-text-strong)]">{value}</div>
      <div className="mt-1.5 truncate text-[11px] text-[var(--workspace-text-muted)]">{sub}</div>
    </div>
    {visual && <div className="shrink-0">{visual}</div>}
  </Tag>
}

interface PerHostRow { item: FleetHost; cpu: Array<number | null>; rx: Array<number | null>; tx: Array<number | null> }

function ResourcesTab({ perHost, times, formatTime, range, counts, fleet, onOpenHost }: {
  perHost: PerHostRow[]; times: number[]; formatTime: (time: number) => string; range: Range; counts: Record<'online' | 'attention' | 'offline' | 'checking', number>; fleet: FleetHost[]; onOpenHost?: (hostId: string) => void
}) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const [heatMetric, setHeatMetric] = useState<'cpuPercent' | 'memoryPercent' | 'diskPercent'>('cpuPercent')
  const top = [...perHost].map((row) => ({ row, avg: mean(row.cpu) })).filter((entry) => entry.avg != null).sort((a, b) => b.avg! - a.avg!).slice(0, 5)
  const from = times.length ? times[0] - (times[1] - times[0] || 0) / 2 : 0
  const to = times.length ? times[times.length - 1] + (times[1] - times[0] || 0) / 2 : 0
  const columns = HEAT_COLUMNS[range]
  const columnTimes = bucketTimes(from, to, columns)
  const heatRows = fleet.map((item) => ({ label: item.host.name, cells: bucketize(seriesOf(item.history, heatMetric), from, to, columns) }))
  const diskTop = fleet.map((item) => {
    const metrics = item.view?.metrics
    return { item, value: latestMetric(item, 'diskPercent'), used: metrics?.diskUsedBytes ?? null, total: metrics?.diskTotalBytes ?? null }
  }).filter((row): row is typeof row & { value: number } => row.value != null).sort((a, b) => b.value - a.value).slice(0, 5)
  const serverCount = fleet.filter((item) => item.host.monitoringMode === 'server' || isProbeInstalled(item.probeRecord)).length
  const bucketWidth = (to - from) / columns
  const bucketLabel = bucketWidth >= DAY_MS / 4 ? `${Math.round(bucketWidth / 3_600_000)} h` : bucketWidth >= 3_600_000 ? '1 h' : `${Math.round(bucketWidth / 60_000)} min`
  const metricLabel = { cpuPercent: 'CPU', memoryPercent: c.metricMemory, diskPercent: c.metricDisk }

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-cluster-cpu" title={fill(c.clusterCpu, { range: c.rangeLabel[range] })} subtitle={fill(c.clusterCpuSub, { count: top.length || 5 })}>
      <TimeSeriesChart times={times} max={100} threshold={85} formatTime={formatTime} formatValue={(v) => `${Math.round(v)}%`} emptyLabel={c.noData}
        series={top.map(({ row }, index) => ({ key: row.item.host.id, label: row.item.host.name, color: CHART_COLORS[index], values: row.cpu, area: index === 0 }))} />
      {top.length > 0 && <ChartLegend className="mt-2" items={top.map(({ row }, index) => ({ label: row.item.host.name, color: CHART_COLORS[index] }))} />}
    </ChartCard>
    <ChartCard testId="fleet-status" title={c.status} subtitle={fill(c.statusSub, { count: fleet.length })}>
      <div className="flex items-center gap-6 py-2">
        <DonutChart size={150} segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]}
          center={`${counts.online + counts.attention}/${fleet.length}`} sub={c.online} />
        <DonutLegend segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Tile label={c.viaServer} value={serverCount} unit={c.unit} />
        <Tile label={c.viaSsh} value={fleet.length - serverCount} unit={c.unit} />
      </div>
    </ChartCard>
    <ChartCard testId="fleet-heatmap" title={fill(c.heatmap, { metric: metricLabel[heatMetric] })} subtitle={fill(c.heatmapSub, { bucket: bucketLabel })}
      actions={<SegmentedTabs label={c.heatmap} value={heatMetric} onChange={setHeatMetric} options={(['cpuPercent', 'memoryPercent', 'diskPercent'] as const).map((value) => ({ value, label: metricLabel[value] }))} />}>
      {heatRows.length ? <Heatmap rows={heatRows} columnLabels={columnTimes.map((time) => range === 168 ? new Date(time).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : range === 1 ? new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : String(new Date(time).getHours()).padStart(2, '0'))} /> : <Empty>{c.noData}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-disk-top" title={c.diskTop} subtitle={c.diskTopSub}>
      {diskTop.length ? <BarList rows={diskTop.map((row) => ({
        key: row.item.host.id,
        label: onOpenHost ? <button type="button" title={c.openCharts} className="truncate hover:underline" onClick={() => onOpenHost(row.item.host.id)}>{row.item.host.name}</button> : row.item.host.name,
        value: row.value,
        color: row.value >= 85 ? STATUS_COLORS.bad : row.value >= 70 ? STATUS_COLORS.warn : CHART_COLORS[0],
        hint: row.total ? `${formatBytes(row.used)} / ${formatBytes(row.total)}` : undefined,
      }))} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function OpsTab({ fleetMetrics, times, formatTime, rx, tx }: { fleetMetrics: ReturnType<typeof useFleetMetrics>; times: number[]; formatTime: (time: number) => string; rx: Array<number | null>; tx: Array<number | null> }) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const [days, setDays] = useState<'7' | '30'>('7')
  const rows = dailyAlertCounts(fleetMetrics.alerts, Number(days), fleetMetrics.to)
  const weekday = (start: number, index: number) => index === rows.length - 1 ? c.today : Number(days) === 7 ? new Date(start).toLocaleDateString(locale, { weekday: 'short' }) : new Date(start).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
  const total = rows.reduce((sum, row) => sum + row.info + row.warning + row.critical, 0)
  const sum = (key: 'info' | 'warning' | 'critical') => rows.reduce((value, row) => value + row[key], 0)
  const weekAgo = fleetMetrics.to - 7 * DAY_MS
  const week = fleetMetrics.alerts.filter((alert) => alert.openedAt >= weekAgo)
  const monitoringCount = week.filter((alert) => alert.source === 'monitoring').length
  const minutes = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length / 60_000) : null
  const ack = minutes(fleetMetrics.alerts.filter((alert) => alert.acknowledgedAt).map((alert) => alert.acknowledgedAt! - alert.openedAt).filter((value) => value >= 0))
  const recover = minutes(fleetMetrics.alerts.filter((alert) => alert.resolvedAt).map((alert) => alert.resolvedAt! - alert.openedAt).filter((value) => value >= 0))
  const latency = fleetMetrics.hosts.map((item) => ({ item, value: latestMetric(item, 'latencyMs') })).filter((row): row is { item: FleetHost; value: number } => row.value != null).sort((a, b) => a.value - b.value)
  const latencyMax = Math.max(100, ...latency.map((row) => row.value))
  const rxPeak = peak(sumBuckets([rx, tx]))
  const peakIndex = rxPeak == null ? -1 : sumBuckets([rx, tx]).indexOf(rxPeak)

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-alert-trend" title={fill(c.alertTrend, { days })} subtitle={fill(c.alertTrendSub, { count: total })}
      actions={<SegmentedTabs label={c.alertTrend} value={days} onChange={setDays} options={[{ value: '7', label: c.days7 }, { value: '30', label: c.days30 }]} />}>
      <StackedBarChart highlightLast labels={rows.map((row, index) => weekday(row.start, index))} rows={rows}
        keys={[{ key: 'info', label: c.info, color: '#38bdf8' }, { key: 'warning', label: c.warning, color: STATUS_COLORS.warn }, { key: 'critical', label: c.critical, color: STATUS_COLORS.bad }]} height={220} />
      <ChartLegend className="mt-2" items={[{ label: c.info, color: '#38bdf8', value: sum('info') }, { label: c.warning, color: STATUS_COLORS.warn, value: sum('warning') }, { label: c.critical, color: STATUS_COLORS.bad, value: sum('critical') }]} />
    </ChartCard>
    <ChartCard testId="fleet-alert-sources" title={c.alertSources} subtitle={c.alertSourcesSub}>
      <div className="flex items-center gap-6 py-2">
        <DonutChart size={150} center={week.length} sub={c.thisWeek} segments={[{ label: c.monitoring, value: monitoringCount, color: CHART_COLORS[0] }, { label: c.localRules, value: week.length - monitoringCount, color: STATUS_COLORS.good }]} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <DonutLegend segments={[{ label: c.monitoring, value: monitoringCount, color: CHART_COLORS[0] }, { label: c.localRules, value: week.length - monitoringCount, color: STATUS_COLORS.good }]} />
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Tile label={c.ackTime} value={ack ?? '—'} unit={ack == null ? undefined : c.minuteUnit} />
            <Tile label={c.recoverTime} value={recover ?? '—'} unit={recover == null ? undefined : c.minuteUnit} />
          </div>
        </div>
      </div>
    </ChartCard>
    <ChartCard testId="fleet-network" title={c.network} subtitle={c.networkSub}>
      <TimeSeriesChart times={times} formatTime={formatTime} formatValue={formatBytesRate} emptyLabel={c.noData}
        series={[{ key: 'rx', label: c.inbound, color: CHART_COLORS[0], values: rx, area: true }, { key: 'tx', label: c.outbound, color: CHART_COLORS[4], values: tx }]} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <ChartLegend items={[{ label: c.inbound, color: CHART_COLORS[0] }, { label: c.outbound, color: CHART_COLORS[4] }]} />
        {rxPeak != null && <span className="font-mono text-xs text-[var(--workspace-text-muted)]">{c.peak} {formatBytesRate(rxPeak)}{peakIndex >= 0 ? ` · ${formatTime(times[peakIndex])}` : ''}</span>}
      </div>
    </ChartCard>
    <ChartCard testId="fleet-latency" title={c.latency} subtitle={c.latencySub}>
      {latency.length ? <BarList max={latencyMax} format={(v) => `${Math.round(v)}`} rows={latency.slice(0, 6).map(({ item, value }) => ({
        key: item.host.id, label: item.host.name, value,
        color: value >= 180 ? STATUS_COLORS.bad : value >= 90 ? STATUS_COLORS.warn : STATUS_COLORS.good,
        hint: item.host.jumpHost ? fill(c.viaJump, { name: item.host.jumpHost }) : undefined,
      }))} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function AssetsTab({ fleetMetrics, network }: { fleetMetrics: ReturnType<typeof useFleetMetrics>; network: ReturnType<typeof useHostNetworkMetadata> }) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const hosts = fleetMetrics.hosts
  const points = hosts.flatMap((item, index) => {
    const cpu = latestMetric(item, 'cpuPercent'); const memory = latestMetric(item, 'memoryPercent')
    if (cpu == null || memory == null) return []
    const disk = latestMetric(item, 'diskPercent') ?? 0
    return [{ key: item.host.id, label: item.host.name, x: cpu, y: memory, size: disk, color: cpu >= 85 || memory >= 85 ? STATUS_COLORS.warn : CHART_COLORS[(index % 4) === 1 ? 3 : 0] }]
  })

  const versions = new Map<string, number>()
  const probeHosts = new Set<string>()
  for (const item of hosts) {
    if (isProbeInstalled(item.probeRecord)) {
      probeHosts.add(item.host.id)
      const ver = item.probeRecord?.current?.manifest.version || c.unknownVersion
      versions.set(ver, (versions.get(ver) ?? 0) + 1)
    }
  }
  for (const agent of fleetMetrics.agents) {
    if (agent.status !== 'retired' && !probeHosts.has(agent.hostId) && hosts.some((item) => item.host.id === agent.hostId)) {
      probeHosts.add(agent.hostId)
      const ver = agent.version || c.unknownVersion
      versions.set(ver, (versions.get(ver) ?? 0) + 1)
    }
  }

  const sshOnly = hosts.filter((item) => !probeHosts.has(item.host.id) && item.host.monitoringMode !== 'server').length
  const serverOnly = hosts.filter((item) => !probeHosts.has(item.host.id) && item.host.monitoringMode === 'server').length
  const probeSegments = [
    ...[...versions.entries()].sort((a, b) => b[1] - a[1]).map(([version, value], index) => ({ label: fill(c.probeVersion, { version }), value, color: index === 0 ? CHART_COLORS[0] : CHART_COLORS[1] })),
    ...(serverOnly ? [{ label: c.serverMode, value: serverOnly, color: CHART_COLORS[3] }] : []),
    { label: c.sshOnly, value: sshOnly, color: STATUS_COLORS.idle },
  ]
  const names = new Map(hosts.map((item) => [item.host.id, item.host.name]))
  const certs = fleetMetrics.certificates.filter((cert) => names.has(cert.hostId) && cert.notAfter != null)
    .map((cert) => ({ cert, days: Math.ceil((cert.notAfter! - fleetMetrics.to) / DAY_MS) })).sort((a, b) => a.days - b.days).slice(0, 8)
  const os = new Map<string, number>()
  for (const item of hosts) {
    const family = osFamily(hostOsString(item))
    if (family) os.set(family, (os.get(family) ?? 0) + 1)
  }
  const osRows = [...os.entries()].sort((a, b) => b[1] - a[1])
  const regions = new Map<string, { count: number; address: string }>()
  for (const item of hosts) {
    const meta = network[item.host.address]
    const label = meta?.resolvedLocationLabel
    if (!label) continue
    const entry = regions.get(label) ?? { count: 0, address: item.host.address }
    entry.count += 1
    regions.set(label, entry)
  }
  const regionRows = [...regions.entries()].sort((a, b) => b[1].count - a[1].count)
  const shownRegions = regionRows.slice(0, 5)
  const rest = regionRows.slice(5)

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-capacity" className="xl:row-span-2" title={c.capacity} subtitle={c.capacitySub}>
      {points.length ? <ScatterChart points={points} xLabel="CPU %" yLabel={c.memory} height={540} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-probes" title={c.probes} subtitle={fill(c.probesSub, { count: hosts.length })}>
      <div className="flex items-center gap-5 py-2">
        <DonutChart size={130} center={probeHosts.size + serverOnly} sub={c.serverMode} segments={probeSegments} />
        <DonutLegend segments={probeSegments} />
      </div>
    </ChartCard>
    <ChartCard testId="fleet-certs" title={c.certs} subtitle={c.certsSub}>
      {certs.length ? <BarList max={90} format={(v) => fill(c.days, { value: Math.round(v) })} rows={certs.map(({ cert, days }) => ({
        key: `${cert.hostId}:${cert.path}`, label: cert.domains[0] ?? cert.path, value: Math.max(0, days),
        color: days <= 14 ? STATUS_COLORS.bad : days <= 30 ? STATUS_COLORS.warn : STATUS_COLORS.good,
        hint: `${names.get(cert.hostId)} · ${cert.path}`,
      }))} /> : <Empty>{c.certsEmpty}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-os" title={c.os} subtitle={c.osSub}>
      {osRows.length ? <StackedBarChart labels={osRows.map(([name]) => name)} rows={osRows.map(([, count]) => ({ count }))} keys={[{ key: 'count', label: c.os, color: CHART_COLORS[0] }]} height={200} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-regions" title={c.region} subtitle={c.regionSub}>
      {shownRegions.length ? <BarList max={Math.max(1, ...regionRows.map(([, entry]) => entry.count))} format={(v) => `${v} ${c.unit}`} rows={[
        ...shownRegions.map(([label, entry]) => ({ key: label, label: <span className="inline-flex items-center gap-1">{network[entry.address] ? <HostRegionMeta network={network[entry.address]} /> : label}</span>, value: entry.count })),
        ...(rest.length ? [{ key: 'rest', label: fill(c.others, { count: rest.length }), value: rest.reduce((sum, [, entry]) => sum + entry.count, 0) }] : []),
      ]} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function Tile({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return <div className="rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2">
    <div className="truncate text-[11px] text-[var(--workspace-text-muted)]">{label}</div>
    <div className="mt-0.5 text-lg font-semibold text-[var(--workspace-text-strong)]">{value}{unit && <small className="ml-0.5 text-xs font-normal text-[var(--workspace-text-muted)]">{unit}</small>}</div>
  </div>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[8rem] items-center justify-center px-4 text-center text-xs text-[var(--workspace-text-subtle)]"><Activity className="mr-1.5 h-3.5 w-3.5 shrink-0" />{children}</div>
}
