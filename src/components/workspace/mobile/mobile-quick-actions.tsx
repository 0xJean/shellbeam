import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Play, ScrollText, SquareTerminal } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import type { WorkspaceAppId } from '@/lib/workspace'
import { WorkspaceAppIcon } from '../workspace-app-grid'
import type { MobileWidgetId } from './mobile-home-prefs'
import { MobileHomeWidget } from './mobile-home-widgets'
import type { MobileHomeData } from './use-mobile-home-data'

const APP_WIDGET: Partial<Record<WorkspaceAppId, MobileWidgetId>> = { docker: 'docker', sitesSsl: 'certs', scheduledTasks: 'tasks', charts: 'cpu', overview: 'host' }

/** v3 `m:quick`: long-press menu. Only actions that already exist elsewhere in the workspace are offered. */
export function MobileQuickActions({ app, data, onOpenApp, onOpenLogs, onTerminalInput, onEditHome, onClose }: {
  app: WorkspaceAppId; data: MobileHomeData; onOpenApp: (app: WorkspaceAppId) => void; onOpenLogs: () => void; onTerminalInput?: (command: string) => void; onEditHome: () => void; onClose: () => void
}) {
  const { t, locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const label = t(`workspace.app.${app}`)
  const widget = APP_WIDGET[app]
  const items: Array<{ key: string; label: string; icon: ReactNode; run: () => void }> = [
    { key: 'open', label: fill(copy.open, { app: label }), icon: <Play />, run: () => onOpenApp(app) },
  ]
  if (app === 'services' || app === 'network') items.push({ key: 'logs', label: copy.viewLogs, icon: <ScrollText />, run: onOpenLogs })
  if (onTerminalInput && app === 'docker') items.push({ key: 'docker-ps', label: copy.terminalDockerPs, icon: <SquareTerminal />, run: () => onTerminalInput('docker ps') })
  if (onTerminalInput && app === 'services') items.push({ key: 'systemctl', label: copy.terminalStatus, icon: <SquareTerminal />, run: () => onTerminalInput('systemctl status') })
  items.push({ key: 'edit', label: copy.editHome, icon: <LayoutGrid />, run: onEditHome })

  return <div data-testid="mobile-quick-actions" role="dialog" aria-modal="true" aria-label={label} className="absolute inset-0 z-50">
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-[var(--workspace-surface-950)] opacity-50 backdrop-blur-xl" />
    <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', damping: 26, stiffness: 320 }}
      className="relative mx-6 mt-[max(calc(env(safe-area-inset-top)+96px),120px)] flex flex-col items-start gap-3.5">
      {widget && <div className="pointer-events-none h-[172px] w-full"><MobileHomeWidget id={widget} data={data} preview /></div>}
      <div className="ml-2 flex flex-col items-center gap-1.5">
        <WorkspaceAppIcon app={app} />
        <span className="text-[11.5px] font-medium text-[var(--workspace-text-strong)]">{label}</span>
      </div>
      <div role="menu" aria-label={label} className="w-[250px] overflow-hidden rounded-[14px] border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-overlay)]">
        {items.map((item) => <button key={item.key} type="button" role="menuitem" onClick={() => { onClose(); item.run() }}
          className="flex h-11 w-full items-center justify-between border-t border-[color:var(--workspace-border-soft)] px-4 text-[16px] text-[var(--workspace-text-strong)] first:border-t-0 active:bg-[var(--workspace-surface-800)] [&_svg]:h-[18px] [&_svg]:w-[18px]">
          <span className="truncate">{item.label}</span>{item.icon}
        </button>)}
      </div>
    </motion.div>
  </div>
}
