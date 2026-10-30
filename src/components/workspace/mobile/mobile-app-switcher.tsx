import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { WorkspaceAppIcon } from '../workspace-app-grid'

/**
 * v3 `m:switcher`: the apps opened in this workspace session, most recent first.
 * Cards show the app identity only; the shell keeps no snapshots of app content.
 */
export function MobileAppSwitcher({ apps, activeApp, hostName, onOpen, onDismiss, onClose }: {
  apps: WorkspaceAppId[]; activeApp: WorkspaceAppId; hostName: string; onOpen: (app: WorkspaceAppId) => void; onDismiss: (app: WorkspaceAppId) => void; onClose: () => void
}) {
  const { t, locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  return <div data-testid="mobile-app-switcher" role="dialog" aria-modal="true" aria-label={copy.switcher} className="absolute inset-0 z-50 flex flex-col">
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-[var(--workspace-surface-950)] opacity-80 backdrop-blur-xl" />
    <div className="relative flex min-h-0 flex-1 snap-x snap-mandatory items-center gap-4 overflow-x-auto px-[12%] pt-[max(env(safe-area-inset-top),16px)]">
      {apps.length === 0 && <p role="status" className="w-full text-center text-sm text-[var(--workspace-text-muted)]">{copy.switcherEmpty}</p>}
      {apps.map((app) => {
        const label = t(`workspace.app.${app}`)
        return <motion.div key={app} layout drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.6, bottom: 0.05 }}
          onDragEnd={(_, info) => { if (info.offset.y < -90 || info.velocity.y < -600) onDismiss(app) }}
          exit={{ opacity: 0, y: -200 }} data-testid={`mobile-switcher-card-${app}`}
          className="relative flex h-[62%] w-[76%] shrink-0 snap-center flex-col">
          <div className="mb-2 flex items-center gap-2">
            <WorkspaceAppIcon app={app} size="sm" />
            <span className="truncate text-[14px] font-semibold text-[var(--workspace-text-strong)]">{label}</span>
            <button type="button" onClick={() => onDismiss(app)} aria-label={fill(copy.closeApp, { app: label })} className="ml-auto flex h-11 w-11 items-center justify-center rounded-full text-[var(--workspace-text-muted)] active:opacity-60">
              <X className="h-5 w-5" />
            </button>
          </div>
          <button type="button" onClick={() => onOpen(app)} aria-label={fill(copy.open, { app: label })}
            className={cn('flex flex-1 flex-col items-center justify-center gap-3 rounded-[22px] border bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-overlay)] active:scale-[0.98] transition-transform',
              app === activeApp ? 'border-[color:var(--workspace-border-strong)]' : 'border-[color:var(--workspace-border-soft)]')}>
            <WorkspaceAppIcon app={app} />
            <span className="text-[17px] font-semibold text-[var(--workspace-text-strong)]">{label}</span>
            <span className="text-[12px] text-[var(--workspace-text-muted)]">{hostName}</span>
          </button>
        </motion.div>
      })}
    </div>
    <p className="relative pb-[max(env(safe-area-inset-bottom),20px)] pt-3 text-center text-[13px] text-[var(--workspace-text-muted)]">{fill(copy.switcherHint, { host: hostName })}</p>
  </div>
}
