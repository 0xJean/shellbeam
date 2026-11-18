import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Plus, Radar, Server, Wrench } from 'lucide-react'
import { HostProbeManageDialog } from '@/components/host-probe-manage-dialog'
import {
  INITIAL_SERVER_DRAFT,
  InlineServerConnect,
  type InlineServerConnectDraft,
} from '@/components/inline-server-connect'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/select'
import { useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import type { HostProfile, MonitoringMode } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { fill, probeInstallCopy } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import { isProbeInstalled } from '@/lib/probe-install'
import { KOMARI_INTEGRATIONS_CHANGED_EVENT } from '@/lib/server-quick-connect'
import { cn } from '@/lib/utils'

export interface MonitoringModeFieldProps {
  value: MonitoringMode
  onChange: (value: MonitoringMode) => void
  disabled?: boolean
  scopeKey?: string
  vaultId?: string
  retainedServer?: boolean
  /** Existing host when editing, enabling inline probe status & Manage button. */
  host?: HostProfile
  installProbe?: boolean
  onInstallProbeChange?: (install: boolean) => void
  serverDraft?: InlineServerConnectDraft
  onServerDraftChange?: (draft: InlineServerConnectDraft) => void
  selectedServerId?: string
  onSelectedServerIdChange?: (id: string) => void
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  onAvailableServersChange?: (servers: KomariIntegration[]) => void
}

/**
 * Unified, zero-popup monitoring & probe option card for HostForm and HostDirectoryEditor.
 * - Unchecked: Native SSH monitoring (zero setup)
 * - Checked: Enhanced Server probe monitoring (inline Server pairing if needed + auto install on save)
 */
export function MonitoringModeField({
  value,
  onChange,
  disabled = false,
  vaultId,
  retainedServer = false,
  host,
  installProbe = true,
  onInstallProbeChange,
  serverDraft = INITIAL_SERVER_DRAFT,
  onServerDraftChange,
  selectedServerId,
  onSelectedServerIdChange,
  onSaveToVault,
  onLoadVaultSecret,
  onAvailableServersChange,
}: MonitoringModeFieldProps) {
  const { locale } = useT()
  const u = unifiedProbeCopy[locale]
  const [servers, setServers] = useState<KomariIntegration[]>([])
  const [serversLoaded, setServersLoaded] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const probeState = useProbeInstallReadiness(
    host ?? ({ id: '__draft__', vaultId: vaultId ?? '', name: '', address: '', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 } as HostProfile),
    Boolean(host && vaultId),
  )
  const alreadyInstalled = Boolean(host && (probeState.readiness?.stage === 'installed' || isProbeInstalled(probeState.record)))
  const installedVersion = probeState.record?.current?.manifest.version

  const loadServers = useCallback(async () => {
    if (!vaultId) {
      setServers([])
      setServersLoaded(true)
      onAvailableServersChange?.([])
      return
    }
    try {
      const list = (await listKomariIntegrations(vaultId)).filter((item) => item.vaultId === vaultId && item.enabled)
      setServers(list)
      onAvailableServersChange?.(list)
      if (list.length > 0 && !selectedServerId) {
        onSelectedServerIdChange?.(list[0].id)
      }
    } catch {
      setServers([])
      onAvailableServersChange?.([])
    } finally {
      setServersLoaded(true)
    }
  }, [onAvailableServersChange, onSelectedServerIdChange, selectedServerId, vaultId])

  useEffect(() => {
    void loadServers()
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ vaultId?: string }>).detail
      if (!detail?.vaultId || detail.vaultId === vaultId) void loadServers()
    }
    window.addEventListener(KOMARI_INTEGRATIONS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(KOMARI_INTEGRATIONS_CHANGED_EVENT, onChanged)
  }, [loadServers, vaultId])

  const isServer = value === 'server'
  const activeServer = servers.find((s) => s.id === selectedServerId) ?? servers[0] ?? null
  const showInlineConnect = isServer && (installProbe || addingServer) && serversLoaded && (servers.length === 0 || addingServer) && Boolean(vaultId && onSaveToVault)

  const toggleProbe = (checked: boolean) => {
    if (disabled) return
    const nextMode: MonitoringMode = checked ? 'server' : 'ssh'
    onChange(nextMode)
    if (checked && !alreadyInstalled) {
      onInstallProbeChange?.(true)
    }
  }

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-2.5"
      data-testid="monitoring-mode-field"
      data-vault-id={vaultId}
    >
      <div
        className={cn(
          'rounded-xl border p-3.5 transition-colors',
          isServer ? 'border-primary/45 bg-primary/5' : 'border-border bg-card/50',
          disabled && 'opacity-60',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              data-testid="monitoring-mode-server"
              checked={isServer}
              disabled={disabled}
              onChange={(e) => toggleProbe(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded accent-[hsl(var(--primary))]"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {alreadyInstalled ? u.formInstalledTitle : u.formTitle}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                    isServer
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Radar className="h-3 w-3" />
                  {isServer
                    ? (alreadyInstalled && installedVersion ? `${u.formProbeBadge} · v${installedVersion}` : u.formProbeBadge)
                    : u.formNativeBadge}
                </span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {alreadyInstalled ? u.formInstalledHint : u.formNativeHint}
              </span>
            </span>
          </label>

          {host && alreadyInstalled && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="host-editor-manage-probe"
              onClick={() => setManageOpen(true)}
              className="h-7 shrink-0 gap-1 text-xs"
            >
              <Wrench className="h-3 w-3" />
              {u.formManageProbe}
            </Button>
          )}
        </div>

        {/* Hidden radio input kept for accessibility/test queries checking SSH state */}
        <input
          type="radio"
          data-testid="monitoring-mode-ssh"
          checked={!isServer}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />

        {isServer && (
          <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
            {!alreadyInstalled && onInstallProbeChange && (
              <label data-testid="host-form-install-probe" className="flex cursor-pointer items-center gap-2 pt-0.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={installProbe}
                  disabled={disabled}
                  onChange={(e) => onInstallProbeChange(e.target.checked)}
                  className="accent-[hsl(var(--primary))]"
                />
                <span>{installProbe ? probeInstallCopy[locale].newHostInstall : u.formAdvancedServerOnly}</span>
              </label>
            )}

            {servers.length > 0 && !addingServer && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)]/60 px-3 py-2 text-xs">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[color:var(--workspace-status-good)]" />
                  {servers.length > 1 ? (
                    <NativeSelect
                      aria-label={u.formTargetServer}
                      value={activeServer?.id ?? ''}
                      onChange={(e) => onSelectedServerIdChange?.(e.target.value)}
                      className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs"
                    >
                      {servers.map((srv) => (
                        <option key={srv.id} value={srv.id}>
                          {srv.name} · {srv.endpoint}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <span className="min-w-0 truncate text-[var(--workspace-text-strong)]">
                      <Server className="mr-1 inline h-3 w-3 text-muted-foreground" />
                      <b>{activeServer?.name}</b>
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{activeServer?.endpoint}</span>
                    </span>
                  )}
                </div>
                {vaultId && onSaveToVault && (
                  <button
                    type="button"
                    data-testid="host-form-connect-new-server"
                    onClick={() => setAddingServer(true)}
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Plus className="h-3 w-3" />
                    {u.formConnectNewServer}
                  </button>
                )}
              </div>
            )}

            {activeServer && !addingServer && !alreadyInstalled && !onInstallProbeChange && (
              <p className="text-xs text-muted-foreground">
                {fill(u.formConnectedHint, { server: activeServer.name || activeServer.endpoint })}
              </p>
            )}

            {showInlineConnect && vaultId && onSaveToVault && (
              <InlineServerConnect
                compact
                vaultId={vaultId}
                saveSecret={onSaveToVault}
                loadSecret={onLoadVaultSecret}
                draft={serverDraft}
                onDraftChange={onServerDraftChange}
                onConnected={(integration) => {
                  setAddingServer(false)
                  onSelectedServerIdChange?.(integration.id)
                  onServerDraftChange?.(INITIAL_SERVER_DRAFT)
                  void loadServers()
                }}
                onCancel={servers.length > 0 ? () => setAddingServer(false) : undefined}
              />
            )}
          </div>
        )}

        {!isServer && retainedServer && (
          <p className="mt-2.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            {u.formKeepNativeSwitch}
          </p>
        )}
      </div>

      {host && manageOpen && (
        <HostProbeManageDialog host={host} open={manageOpen} onOpenChange={setManageOpen} />
      )}
    </fieldset>
  )
}
