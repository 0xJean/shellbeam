import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { ArrowLeft, BatteryFull, Search, Signal, Wifi } from 'lucide-react'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'

interface WorkspaceMobileShellProps {
  hostName: string
  hostAddress: string
  hostId?: string | null
  hosts?: HostProfile[]
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceMobileShell({
  hostName,
  hostAddress,
  hostId,
  hosts = [],
  resolveAuthSecret,
  activeApp,
  onSelectApp,
}: WorkspaceMobileShellProps) {
  const content = (() => {
    if (activeApp === 'files') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceFilesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'processes') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceProcessesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'services') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceServicesApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'logs') {
      if (hostId && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    return <WorkspaceEmptyApp app={activeApp} />
  })()

  const dockApps: WorkspaceAppId[] = ['overview', 'files', 'services', 'logs']
  const isOverview = activeApp === 'overview'
  const switcherApps = Array.from(new Set([...dockApps, activeApp]))

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#8ec5ff_0%,#b9d6ff_24%,#dbeafe_52%,#eff6ff_100%)] text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.35),transparent_26%),radial-gradient(circle_at_bottom,rgba(59,130,246,0.18),transparent_30%)]" />

      <div className="relative flex items-center justify-between px-5 pb-3 pt-4 text-sm font-semibold text-slate-900">
        <span>9:41</span>
        <div className="flex items-center gap-1.5 text-slate-700">
          <Signal className="h-4 w-4" />
          <Wifi className="h-4 w-4" />
          <BatteryFull className="h-4 w-4" />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto px-4">
        {isOverview ? (
          <div className="space-y-5 pb-32">
            <div>
              <div className="text-sm font-medium text-slate-600">{t('workspace.mobile.title')}</div>
              <div className="mt-1 text-4xl font-semibold tracking-tight text-slate-950">Home Screen</div>
              <div className="mt-1 text-sm text-slate-600">{hostName} · {hostAddress}</div>
            </div>

            <button
              type="button"
              onClick={() => onSelectApp('terminal')}
              className="flex w-full items-center gap-3 rounded-[22px] border border-white/70 bg-white/55 px-4 py-3 text-left shadow-[0_10px_30px_rgba(15,23,42,0.10)] backdrop-blur"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/8">
                <Search className="h-5 w-5 text-slate-700" />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{t('workspace.mobile.spotlight')}</div>
                <div className="text-xs text-slate-600">{t('workspace.mobile.spotlightHint')}</div>
              </div>
            </button>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[26px] border border-white/70 bg-white/70 px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.10)] backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.surface')}</div>
                <div className="mt-3 text-2xl font-semibold text-slate-950">{t('workspace.mobile.touchReady')}</div>
                <div className="mt-2 text-sm text-slate-600">{hostName}</div>
              </div>
              <div className="rounded-[26px] border border-white/70 bg-white/70 px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.10)] backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t('workspace.mobile.control')}</div>
                <div className="mt-3 text-2xl font-semibold text-slate-950">{t('workspace.mobile.quickOps')}</div>
                <div className="mt-2 text-sm text-slate-600">{hostAddress}</div>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-900/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-400/40" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-400/40" />
            </div>

            <div className="rounded-[32px] border border-white/65 bg-white/28 px-3 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] backdrop-blur-sm">
              <div className="mb-4 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">{t('workspace.section.applications')}</div>
              <div className="min-h-[22rem]">
                <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} variant="mobile" />
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 z-20 flex flex-col overflow-hidden rounded-t-[34px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.84),rgba(255,255,255,0.94))] shadow-[0_-8px_24px_rgba(15,23,42,0.10),0_18px_44px_rgba(15,23,42,0.16)] backdrop-blur-xl">
            <div className="flex justify-center pt-2">
              <div className="h-1.5 w-12 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3">
              <button
                type="button"
                onClick={() => onSelectApp('overview')}
                className="flex h-10 items-center gap-2 rounded-full border border-white/80 bg-white/75 px-3 text-slate-800 shadow-sm"
                aria-label="Back to Home Screen"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="text-sm font-semibold">{t('workspace.mobile.home')}</span>
              </button>
              <div className="text-center">
                <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">{hostName}</div>
                <div className="text-xl font-semibold tracking-tight text-slate-950">{t(`workspace.app.${activeApp}`)}</div>
              </div>
              <button
                type="button"
                onClick={() => onSelectApp('overview')}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/80 bg-white/75 text-slate-700 shadow-sm"
                aria-label="Close mobile app"
              >
                <Search className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 pb-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {switcherApps.map((app) => (
                  <button
                    key={app}
                    type="button"
                    onClick={() => onSelectApp(app)}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      activeApp === app
                        ? 'border-sky-300 bg-sky-100 text-sky-800'
                        : 'border-white/80 bg-white/80 text-slate-700'
                    }`}
                  >
                    {t(`workspace.app.${app}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-3 pb-24">
              <div className="overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
                <div className="flex items-center justify-between border-b border-slate-200/80 px-4 py-3 text-sm font-semibold text-slate-900">
                  <span>{t('workspace.mobile.title')}</span>
                  <Search className="h-4 w-4 text-slate-500" />
                </div>
                <div className="min-h-0 p-3">
                  {content}
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-3">
              <div className="rounded-[30px] border border-white/75 bg-white/82 px-3 py-3 shadow-[0_10px_28px_rgba(15,23,42,0.10)] backdrop-blur">
                <WorkspaceAppGrid
                  activeApp={activeApp}
                  onSelectApp={onSelectApp}
                  variant="mobile"
                  apps={dockApps}
                />
              </div>
              <div className="mx-auto mt-3 h-1.5 w-32 rounded-full bg-slate-900/80" />
            </div>
          </div>
        )}
      </div>

      {isOverview && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-3 pt-2">
          <div className="pointer-events-auto rounded-[30px] border border-white/75 bg-white/82 px-3 py-3 shadow-[0_10px_28px_rgba(15,23,42,0.10)] backdrop-blur">
            <div className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {t('workspace.mobile.dock')}
            </div>
            <WorkspaceAppGrid
              activeApp={activeApp}
              onSelectApp={onSelectApp}
              variant="mobile"
              apps={dockApps}
            />
          </div>
          <div className="mx-auto mt-3 h-1.5 w-32 rounded-full bg-slate-900/80" />
        </div>
      )}
    </div>
  )
}
