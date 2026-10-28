import { useEffect, useState, type ReactNode } from 'react'
import { Archive, ArrowLeftRight, BookOpen, ChevronRight, Clock, Code2, KeyRound, Network, RefreshCw, Shield } from 'lucide-react'
import type { SidebarNavId } from '@/components/pc-nav-sidebar'
import { useT } from '@/lib/i18n'
import { listPortForwardRules, portForwardTunnelStatus, type PortForwardRule } from '@/lib/port-forward'

const COPY = {
  en: { title: 'Tools', running: 'Running port forwards', all: 'All', none: 'No port forwards running', connection: 'Connection', library: 'Library', data: 'Data', help: 'Help', rules: '{count} rules', runningCount: '{count} running' },
  'zh-CN': { title: '工具', running: '运行中的端口转发', all: '全部', none: '没有正在运行的端口转发', connection: '连接', library: '资料库', data: '数据', help: '帮助', rules: '{count} 条', runningCount: '{count} 条运行中' },
} as const

const fill = (template: string, count: number) => template.replace('{count}', String(count))

/**
 * Mobile "Tools" tab. With five fixed tabs (hosts, sessions, files, tools,
 * settings) there is no "More" menu; everything else lives here, with the
 * live port forwards first because they are what people check on the go.
 */
export function MobileToolsPage({ vaultId, onNavigate }: { vaultId?: string | null; onNavigate: (nav: SidebarNavId) => void }) {
  const { t, locale } = useT()
  const c = COPY[locale]
  const [rules, setRules] = useState<PortForwardRule[]>([])
  const [running, setRunning] = useState<Set<string>>(new Set())

  useEffect(() => {
    let live = true
    void (async () => {
      const list = await listPortForwardRules(vaultId).catch(() => [] as PortForwardRule[])
      const states = await Promise.all(list.map(async (rule) => [rule.id, await portForwardTunnelStatus(rule.id).catch(() => false)] as const))
      if (!live) return
      setRules(list)
      setRunning(new Set(states.filter(([, on]) => on).map(([id]) => id)))
    })()
    return () => { live = false }
  }, [vaultId])

  const active = rules.filter((rule) => running.has(rule.id))
  const row = (nav: SidebarNavId, icon: ReactNode, color: string, label: string, value?: string, hint?: string) => (
    <button key={nav} type="button" data-testid={`mobile-tool-${nav}`} onClick={() => onNavigate(nav)}
      className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left active:bg-[var(--workspace-surface-800)]">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white [&_svg]:h-4 [&_svg]:w-4" style={{ background: color }}>{icon}</span>
      <span className="min-w-0 flex-1 py-2">
        <span className="block text-[15px] text-[var(--workspace-text-strong)]">{label}</span>
        {hint && <span className="block truncate text-xs text-[var(--workspace-text-muted)]">{hint}</span>}
      </span>
      {value && <span className="text-sm text-[var(--workspace-text-muted)]">{value}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
    </button>
  )
  const group = (title: string, rows: ReactNode[]) => (
    <section className="space-y-1.5">
      <h3 className="px-4 text-[13px] text-[var(--workspace-text-muted)]">{title}</h3>
      <div className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden p-0">{rows}</div>
    </section>
  )

  return (
    <div data-testid="mobile-tools-page" className="mx-auto max-w-xl space-y-5 px-4 pb-8 pt-4">
      <h2 className="px-1 text-[28px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h2>
      <section className="sb-card p-4">
        <div className="mb-2 flex items-center justify-between text-[13px] text-[var(--workspace-text-muted)]">
          <span>{c.running}</span>
          <button type="button" className="text-[var(--workspace-accent-text)]" onClick={() => onNavigate('port-forwarding')}>{c.all}</button>
        </div>
        {active.length === 0 ? <p className="py-1 text-sm text-[var(--workspace-text-subtle)]">{c.none}</p> : active.slice(0, 4).map((rule) => (
          <div key={rule.id} data-testid="mobile-tool-forward" className="flex items-center gap-3 border-t border-[color:var(--workspace-border-soft)] py-2.5 first:border-t-0">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--workspace-status-good)]" />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{rule.name}</b>
              <small className="block truncate font-mono text-xs text-[var(--workspace-text-muted)]">{rule.bindHost}:{rule.bindPort} → {rule.type === 'dynamic' ? 'SOCKS' : `${rule.targetHost}:${rule.targetPort}`}</small>
            </span>
          </div>
        ))}
      </section>
      {group(c.connection, [
        row('port-forwarding', <ArrowLeftRight />, '#5e5ce6', t('nav.portForward'), fill(c.rules, rules.length), active.length ? fill(c.runningCount, active.length) : undefined),
        row('asset-inventory', <Network />, '#0a84ff', t('nav.assetInventory')),
        row('known-hosts', <Shield />, '#ff453a', t('nav.knownHosts')),
      ])}
      {group(c.library, [
        row('keychain', <KeyRound />, '#ff9f0a', t('nav.keychain')),
        row('snippets', <Code2 />, '#30c75a', t('nav.snippets')),
        row('activity', <Clock />, '#8e8e93', t('nav.activity')),
      ])}
      {group(c.data, [
        row('sync', <RefreshCw />, '#64d2ff', t('nav.sync')),
        row('backup', <Archive />, '#ac8e68', t('nav.backup')),
      ])}
      {group(c.help, [row('guide', <BookOpen />, '#bf5af2', t('guide.title'))])}
    </div>
  )
}
