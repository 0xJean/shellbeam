import type { HostProfile } from '@/lib/hosts'
import { t } from '@/lib/i18n'
import type { WorkspaceAppId } from '@/lib/workspace'
import { BatteryFull, ChevronLeft, Signal, Wifi, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WorkspaceAppGrid } from './workspace-app-grid'
import { WorkspaceEmptyApp } from './workspace-empty-app'
import { WorkspaceFilesApp } from './workspace-files-app'
import { WorkspaceLogsApp } from './workspace-logs-app'
import { WorkspaceProcessesApp } from './workspace-processes-app'
import { WorkspaceServicesApp } from './workspace-services-app'

function LiveClock() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )
  useEffect(() => {
    const id = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    }, 10000)
    return () => window.clearInterval(id)
  }, [])
  return <>{time}</>
}

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
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceFilesApp presentation="mobile" selectedHostId={hostId} selectedHostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'processes') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceProcessesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'services') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceServicesApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    if (activeApp === 'logs') {
      if ((hostId || hostAddress) && resolveAuthSecret) {
        return <WorkspaceLogsApp selectedHostId={hostId} hostAddress={hostAddress} hosts={hosts} resolveAuthSecret={resolveAuthSecret} />
      }
      return <WorkspaceEmptyApp app={activeApp} />
    }
    return <WorkspaceEmptyApp app={activeApp} />
  })()

  // Terminal is the primary app, then Files, Services, Overview for settings
  const dockApps: WorkspaceAppId[] = ['terminal', 'files', 'services', 'overview']
  const isOverview = activeApp === 'overview'

  return (
    <div
      data-testid="workspace-mobile-shell"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0a192f] text-foreground"
    >
      {/* iOS Springboard Wallpaper (Blurred Gradients) */}
      <div className="absolute inset-0 z-0">
        <div className="absolute -top-[20%] -left-[10%] h-[50%] w-[70%] rounded-full bg-blue-500/40 blur-[120px]" />
        <div className="absolute top-[20%] -right-[20%] h-[60%] w-[60%] rounded-full bg-purple-600/30 blur-[100px]" />
        <div className="absolute -bottom-[10%] left-[10%] h-[40%] w-[80%] rounded-full bg-teal-500/30 blur-[100px]" />
        <div className="absolute inset-0 bg-black/10 backdrop-blur-[2px]" />
      </div>

      {/* iOS Status Bar */}
      <div className="relative z-10 flex items-center justify-between px-6 pb-2 pt-[max(env(safe-area-inset-top),16px)] text-[15px] font-semibold text-white drop-shadow-md">
        <span><LiveClock /></span>
        <div className="flex items-center gap-1.5">
          <Signal className="h-[14px] w-[14px]" />
          <Wifi className="h-[14px] w-[14px]" />
          <BatteryFull className="h-[18px] w-[18px]" />
        </div>
      </div>

      {/* Springboard (Home Screen) */}
      <motion.div 
        className="relative z-10 flex flex-1 flex-col px-4 pt-6"
        initial={false}
        animate={{ 
          scale: isOverview ? 1 : 0.95,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <div className="mb-8 text-center text-white drop-shadow-md">
          <div className="text-2xl font-semibold tracking-tight">{hostName}</div>
          <div className="text-sm text-white/80">{hostAddress}</div>
        </div>

        <div className="min-h-[22rem]">
          <WorkspaceAppGrid activeApp={activeApp} onSelectApp={onSelectApp} variant="ios-grid" />
        </div>
      </motion.div>

      {/* Fixed iOS Dock */}
      <motion.div 
        className="absolute bottom-4 left-4 right-4 z-20"
        initial={false}
        animate={{ 
          y: isOverview ? 0 : 100,
          opacity: isOverview ? 1 : 0,
          pointerEvents: isOverview ? 'auto' : 'none'
        }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <div className="rounded-[32px] border border-white/20 bg-white/20 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-2xl dark:border-white/10 dark:bg-black/30 pb-[max(env(safe-area-inset-bottom,12px),12px)]">
          <WorkspaceAppGrid
            activeApp={activeApp}
            onSelectApp={onSelectApp}
            variant="ios-dock"
            apps={dockApps}
          />
        </div>
      </motion.div>

      {/* Full Screen App View */}
      <AnimatePresence>
        {!isOverview && (
          <motion.div
            key="app-view"
            data-testid="workspace-mobile-app-frame"
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="absolute inset-0 z-30 flex flex-col bg-white dark:bg-[#0f172a] overflow-hidden"
          >
            {/* Frosted Navigation Bar */}
            <div className="relative z-40 flex items-center justify-between border-b border-slate-200/50 bg-white/80 pb-3 pt-[max(env(safe-area-inset-top),16px)] px-2 shadow-sm backdrop-blur-xl dark:border-slate-800/50 dark:bg-slate-900/80">
              <button
                type="button"
                onClick={() => onSelectApp('overview')}
                className="flex h-11 min-w-[44px] items-center gap-1 rounded-full px-2 text-blue-500 active:opacity-60 transition-opacity"
                aria-label="Back to Home Screen"
              >
                <ChevronLeft className="h-6 w-6 -ml-1" />
                <span className="text-[17px] font-medium leading-none">Home</span>
              </button>
              
              <div className="absolute left-1/2 -translate-x-1/2 text-center">
                <div className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-white">
                  {t(`workspace.app.${activeApp}`)}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {hostName}
                </div>
              </div>

              <button
                type="button"
                className="flex h-11 min-w-[44px] items-center justify-end px-3 text-blue-500 active:opacity-60 transition-opacity"
                aria-label="Search"
              >
                <Search className="h-5 w-5" />
              </button>
            </div>

            {/* App Content */}
            <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950 pb-[env(safe-area-inset-bottom)]">
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
