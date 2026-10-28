import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Info, Lock, Server } from 'lucide-react'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { cn } from '@/lib/utils'
import { KomariSettingsSection } from './komari-settings-section'
import { HostRuleSettingsSection } from './host-notification-rules-panel'
import { NotificationSettingsSection } from './notification-settings-section'
import { MonitoringServicePanel } from './monitoring-service-panel'
import { CardHead, Note, mutedText, softBorder } from './monitor-settings-ui'
import { Button } from './ui/button'

export type MonitorSettingsPage = 'services' | 'server' | 'rules' | 'offline' | 'local'
const PAGES: MonitorSettingsPage[] = ['services', 'server', 'rules', 'offline', 'local']

export function MonitorSettingsSection({ initialPage = 'services' }: { initialPage?: MonitorSettingsPage }) {
  const { activeVaultId, vaultStatusState } = useVault()
  const { locale } = useT(); const copy = monitorSettingsCopy[locale]
  const unlocked = vaultStatusState?.unlocked === true
  const [page, setPage] = useState<MonitorSettingsPage>(initialPage)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ vaultId: string; items: KomariIntegration[] } | null>(null)

  useEffect(() => {
    if (!unlocked) return
    let alive = true
    void listKomariIntegrations(activeVaultId).then(items => {
      if (alive) setLoaded({ vaultId: activeVaultId, items: items.filter(item => item.vaultId === activeVaultId) })
    }).catch(() => {})
    return () => { alive = false }
  }, [activeVaultId, unlocked, page])

  const integrations = unlocked && loaded?.vaultId === activeVaultId ? loaded.items : []
  const known = unlocked && loaded?.vaultId === activeVaultId
  const labels: Record<MonitorSettingsPage, string> = { services: copy.tabServices, server: copy.tabServer, rules: copy.tabRules, offline: copy.tabOffline, local: copy.tabLocal }
  const openServer = (id: string) => { setServiceId(id); setPage('server') }

  return <div className="min-w-0 space-y-4" data-testid="monitor-settings">
    <div>
      <h2 className="text-lg font-semibold text-[color:var(--workspace-text-strong)]">{copy.title}</h2>
      <p className={cn('mt-0.5 text-xs', mutedText)}>{copy.description}</p>
    </div>
    <div role="tablist" aria-label={copy.sections} className={cn('flex gap-5 overflow-x-auto border-b', softBorder)}>
      {PAGES.map(item => <button key={item} type="button" role="tab" id={`monitor-tab-${item}`} aria-selected={page === item} aria-controls="monitor-tab-panel" data-testid={`monitor-tab-${item}`}
        onClick={() => setPage(item)}
        className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 pb-2 pt-1 text-sm transition-colors', page === item ? 'border-[color:var(--workspace-primary-500)] font-medium text-[color:var(--workspace-text-strong)]' : cn('border-transparent hover:text-[color:var(--workspace-text)]', mutedText))}>
        {labels[item]}{item === 'services' && known && integrations.length > 0 && <em className={cn('ml-1.5 not-italic text-[11px]', mutedText)}>{integrations.length}</em>}
      </button>)}
    </div>
    <div role="tabpanel" id="monitor-tab-panel" aria-labelledby={`monitor-tab-${page}`} className="min-w-0">
      {page === 'services' && <KomariSettingsSection onOpenServiceConfiguration={openServer} onIntegrationsChange={(vaultId, items) => setLoaded({ vaultId, items })} />}
      {(page === 'server' || page === 'rules') && <ServicePage key={page} mode={page} unlocked={unlocked} known={known} integrations={integrations} selectedId={serviceId} onSelect={setServiceId} onAdd={() => setPage('services')} />}
      {page === 'offline' && <div className="space-y-3">
        <HostRuleSettingsSection emptyState={<EmptyCard icon={unlocked ? Info : Lock}>{unlocked ? copy.offlineEmpty : copy.offlineLocked}</EmptyCard>} />
        <Note>{copy.offlineAlsoInEditor}</Note>
      </div>}
      {page === 'local' && <NotificationSettingsSection />}
    </div>
  </div>
}

function ServicePage({ mode, unlocked, known, integrations, selectedId, onSelect, onAdd }: { mode: 'server' | 'rules'; unlocked: boolean; known: boolean; integrations: KomariIntegration[]; selectedId: string | null; onSelect: (id: string) => void; onAdd: () => void }) {
  const { locale } = useT(); const copy = monitorSettingsCopy[locale]
  if (!unlocked) return <EmptyCard icon={Lock}>{copy.lockedServer}</EmptyCard>
  if (!known) return null
  if (!integrations.length) return <EmptyCard icon={Server} action={<Button size="sm" variant="outline" className="gap-1.5" onClick={onAdd}>{copy.goServices}<ArrowRight className="h-3.5 w-3.5" /></Button>}>{copy.addFirst}</EmptyCard>
  const service = integrations.find(item => item.id === selectedId) ?? integrations[0]
  const panel = <MonitoringServicePanel key={`${mode}:${service.id}`} service={service} initialTarget={mode === 'rules' ? 'load-policy' : 'settings'} embedded />
  const choices = integrations.map(item => {
    const active = item.id === service.id
    return <button key={item.id} type="button" aria-pressed={active} onClick={() => onSelect(item.id)}
      className={cn(mode === 'server' ? 'flex w-full min-w-0 items-center gap-3 border-b border-l-2 px-3 py-2.5 text-left last:border-b-0' : 'flex min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left', softBorder,
        active ? 'border-l-[color:var(--workspace-primary-500)] bg-[color:var(--workspace-accent-subtle)]' : 'border-l-transparent hover:bg-[color:var(--workspace-surface-800)]')}>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[color:var(--workspace-text-strong)]">{item.name}</span>{mode === 'server' && <span className={cn('block truncate text-xs', mutedText)}>{item.endpoint}</span>}</span>
      {mode === 'server' && <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', item.enabled ? 'bg-[color:var(--workspace-status-good)]' : 'bg-[color:var(--workspace-text-subtle)]')} />}
    </button>
  })
  if (mode === 'rules') return <div className="space-y-3">
    {integrations.length > 1 && <div className="flex flex-wrap items-center gap-2"><span className={cn('text-xs', mutedText)}>{copy.configTarget}</span>{choices}</div>}
    <Note>{copy.rulesScope}</Note>
    {panel}
  </div>
  return <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:items-start">
    <div className="min-w-0 space-y-2.5">
      <div className="sb-card overflow-hidden">
        <CardHead title={copy.configTarget} hint={service.name} />
        <div>{choices}</div>
      </div>
      <Note>{copy.serverScope}</Note>
    </div>
    <div className="min-w-0">{panel}</div>
  </div>
}

function EmptyCard({ icon: Icon, action, children }: { icon: typeof Info; action?: ReactNode; children: ReactNode }) {
  return <div className={cn('sb-card flex flex-col items-center gap-3 px-6 py-10 text-center text-sm', mutedText)}>
    <Icon className="h-5 w-5" aria-hidden="true" /><p className="max-w-md">{children}</p>{action}
  </div>
}
