import { useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import { WORKSPACE_APPS, type WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { WorkspaceAppIcon } from '../workspace-app-grid'
import type { MobileHomeData } from './use-mobile-home-data'

const LIMIT = 5
const panel = 'rounded-[14px] border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 pb-1 pt-1.5 shadow-[var(--workspace-shadow-overlay)]'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className={panel}>
    <h3 className="pb-1 pt-0.5 text-[12px] font-semibold text-[var(--workspace-text-muted)]">{title}</h3>
    <ul className="divide-y divide-[color:var(--workspace-border-soft)]">{children}</ul>
  </section>
}

function Row({ icon, title, sub, onSelect, action }: { icon: ReactNode; title: string; sub?: string; onSelect: () => void; action?: { label: string; onClick: () => void } }) {
  return <li className="flex items-center gap-2.5">
    <button type="button" onClick={onSelect} className="flex min-h-[48px] min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left active:opacity-60">
      {icon}
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium text-[var(--workspace-text-strong)]">{title}</span>
        {sub && <span className="block truncate text-[12px] text-[var(--workspace-text-muted)]">{sub}</span>}
      </span>
    </button>
    {action && <button type="button" onClick={action.onClick} className="flex h-11 shrink-0 items-center">
      <span className="flex h-7 items-center rounded-full bg-[var(--workspace-accent-subtle)] px-3 text-[13px] font-semibold text-[var(--workspace-accent-text)]">{action.label}</span>
    </button>}
  </li>
}

/** v3 `m:spot`: searches apps and what this host's last scan already knows (services, containers, scheduled tasks). */
export function MobileSpotlight({ data, onOpenApp, onOpenLogs, onClose }: { data: MobileHomeData; onOpenApp: (app: WorkspaceAppId) => void; onOpenLogs: (unit: string) => void; onClose: () => void }) {
  const { t, locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const match = (...values: Array<string | undefined>) => !needle || values.some((value) => value?.toLowerCase().includes(needle))
  const apps = WORKSPACE_APPS.filter((app) => match(t(`workspace.app.${app}`), app))
  const services = needle ? (data.inventory?.services ?? []).filter((service) => match(service.name)).slice(0, LIMIT) : []
  const containers = needle ? (data.inventory?.containers ?? []).filter((container) => match(container.name, container.image)).slice(0, LIMIT) : []
  const tasks = needle ? data.tasks.filter((task) => match(task.name, task.command)).slice(0, LIMIT) : []
  const nothing = !apps.length && !services.length && !containers.length && !tasks.length
  const smallIcon = (app: WorkspaceAppId) => <WorkspaceAppIcon app={app} size="sm" />

  return <div data-testid="mobile-spotlight" role="dialog" aria-modal="true" aria-label={copy.search} className="absolute inset-0 z-50 flex flex-col">
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-[var(--workspace-surface-950)] opacity-70 backdrop-blur-xl" />
    <div className="relative flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 pb-[max(env(safe-area-inset-bottom),12px)] pt-[max(env(safe-area-inset-top),16px)]">
      <div className="flex items-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-3">
        <Search className="h-[18px] w-[18px] shrink-0 text-[var(--workspace-text-subtle)]" aria-hidden="true" />
        <input data-testid="mobile-spotlight-input" autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
          placeholder={copy.searchPlaceholder} aria-label={copy.searchPlaceholder} className="h-11 min-w-0 flex-1 bg-transparent text-[17px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
        <button type="button" onClick={onClose} className="h-11 shrink-0 px-3 text-[16px] text-[var(--workspace-accent-text)]">{copy.cancel}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {apps.length > 0 && <Group title={copy.apps}>{apps.map((app) => <Row key={app} icon={smallIcon(app)} title={t(`workspace.app.${app}`)} onSelect={() => onOpenApp(app)} />)}</Group>}
        {services.length > 0 && <Group title={copy.services}>{services.map((service) => <Row key={service.name} icon={smallIcon('services')} title={service.name} sub={`${t('workspace.app.services')} · ${service.active}`}
          onSelect={() => onOpenApp('services')} action={{ label: t('workspace.app.logs'), onClick: () => onOpenLogs(service.name) }} />)}</Group>}
        {containers.length > 0 && <Group title={copy.containersGroup}>{containers.map((container) => <Row key={container.name} icon={smallIcon('docker')} title={container.name} sub={[container.image, container.status].filter(Boolean).join(' · ')} onSelect={() => onOpenApp('docker')} />)}</Group>}
        {tasks.length > 0 && <Group title={copy.tasks}>{tasks.map((task) => <Row key={task.id} icon={smallIcon('scheduledTasks')} title={task.name} sub={task.command} onSelect={() => onOpenApp('scheduledTasks')} />)}</Group>}
        {nothing && <p role="status" className={cn(panel, 'py-4 text-center text-[13px] text-[var(--workspace-text-muted)]')}>{copy.noResults}</p>}
      </div>
    </div>
  </div>
}
