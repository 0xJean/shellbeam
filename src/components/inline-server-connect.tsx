import { useState } from 'react'
import { CircleCheck, Eye, EyeOff, KeyRound, Loader2, PlugZap, Server, Sparkles, UserCog } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import type { KomariIntegration } from '@/lib/komari-config'
import { fill } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import {
  connectShellbeamServer,
  formatServerConnectError,
  type ServerQuickAuthMode,
} from '@/lib/server-quick-connect'
import { cn } from '@/lib/utils'

export interface InlineServerConnectDraft {
  name: string
  endpoint: string
  authMode: ServerQuickAuthMode
  apiKey: string
  username: string
  password: string
  twoFactor: string
  installToken: string
  metricDsn: string
}

export const INITIAL_SERVER_DRAFT: InlineServerConnectDraft = {
  name: '',
  endpoint: '',
  authMode: 'authorize',
  apiKey: '',
  username: 'admin',
  password: '',
  twoFactor: '',
  installToken: '',
  metricDsn: './data/metrics.db',
}

interface InlineServerConnectProps {
  vaultId: string
  saveSecret: (key: string, value: string) => Promise<void>
  loadSecret?: (key: string) => Promise<string | null>
  /** Controlled draft when embedded inside a parent form (e.g. HostForm) so parent Save can also submit it. */
  draft?: InlineServerConnectDraft
  onDraftChange?: (next: InlineServerConnectDraft) => void
  onConnected?: (integration: KomariIntegration, nodeCount: number) => void
  onCancel?: () => void
  compact?: boolean
  className?: string
}

export function InlineServerConnect({
  vaultId,
  saveSecret,
  loadSecret,
  draft: controlledDraft,
  onDraftChange,
  onConnected,
  onCancel,
  compact = false,
  className,
}: InlineServerConnectProps) {
  const { locale } = useT()
  const c = unifiedProbeCopy[locale]
  const [ownDraft, setOwnDraft] = useState<InlineServerConnectDraft>(INITIAL_SERVER_DRAFT)
  const draft = controlledDraft ?? ownDraft
  const update = (patch: Partial<InlineServerConnectDraft>) => {
    const next = { ...draft, ...patch }
    if (onDraftChange) onDraftChange(next)
    else setOwnDraft(next)
    setError('')
    setConnected(null)
  }

  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState<{ integration: KomariIntegration; nodeCount: number } | null>(null)

  const handleConnect = async () => {
    if (busy) return
    if (!draft.endpoint.trim()) {
      setError(c.endpointRequired)
      return
    }
    if (draft.authMode === 'key' && !draft.apiKey.trim()) {
      setError(c.apiKeyRequired)
      return
    }
    if (draft.authMode !== 'key' && (!draft.username.trim() || !draft.password)) {
      setError(c.credentialsRequired)
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await connectShellbeamServer({
        vaultId,
        name: draft.name,
        endpoint: draft.endpoint,
        authMode: draft.authMode,
        apiKey: draft.apiKey,
        username: draft.username,
        password: draft.password,
        twoFactor: draft.twoFactor,
        installToken: draft.installToken,
        metricDsn: draft.metricDsn,
        saveSecret,
        loadSecret,
      })
      setConnected(result)
      onConnected?.(result.integration, result.nodeCount)
    } catch (cause) {
      setError(formatServerConnectError(cause, locale))
    } finally {
      setBusy(false)
    }
  }

  const modes: Array<{ id: ServerQuickAuthMode; label: string; Icon: typeof UserCog }> = [
    { id: 'authorize', label: c.authAuthorize, Icon: UserCog },
    { id: 'key', label: c.authKey, Icon: KeyRound },
    { id: 'initialize', label: c.authInitialize, Icon: Sparkles },
  ]

  return (
    <div
      data-testid="inline-server-connect"
      className={cn(
        'space-y-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]/70 p-3.5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--workspace-text-strong)]">
            <Server className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
            <span>{c.serverBoxTitle}</span>
          </div>
          {!compact && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.serverBoxSubtitle}</p>}
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className="shrink-0 text-xs text-primary hover:underline">
            {c.formUseExistingServer}
          </button>
        )}
      </div>

      <div role="tablist" className="grid grid-cols-3 gap-1 rounded-lg border border-border/60 bg-background/60 p-0.5">
        {modes.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`inline-server-mode-${id}`}
            aria-selected={draft.authMode === id}
            disabled={busy}
            onClick={() => update({ authMode: id })}
            className={cn(
              'flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors',
              draft.authMode === id
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-foreground">{c.serverEndpoint}</span>
          <Input
            data-testid="inline-server-endpoint"
            value={draft.endpoint}
            disabled={busy}
            onChange={(e) => update({ endpoint: e.target.value })}
            placeholder={c.serverEndpointPlaceholder}
            className="h-8 font-mono text-xs"
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-foreground">{c.serverName}</span>
          <Input
            data-testid="inline-server-name"
            value={draft.name}
            disabled={busy}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={c.serverNamePlaceholder}
            className="h-8 text-xs"
          />
        </label>
      </div>

      {draft.authMode === 'key' ? (
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-foreground">{c.apiKeyLabel}</span>
          <div className="relative">
            <Input
              data-testid="inline-server-api-key"
              type={showSecret ? 'text' : 'password'}
              value={draft.apiKey}
              disabled={busy}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={c.apiKeyPlaceholder}
              className="h-8 pr-8 font-mono text-xs"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </label>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-foreground">{c.usernameLabel}</span>
            <Input
              data-testid="inline-server-username"
              value={draft.username}
              disabled={busy}
              onChange={(e) => update({ username: e.target.value })}
              placeholder={c.usernamePlaceholder}
              className="h-8 text-xs"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-foreground">{c.passwordLabel}</span>
            <div className="relative">
              <Input
                data-testid="inline-server-password"
                type={showSecret ? 'text' : 'password'}
                value={draft.password}
                disabled={busy}
                onChange={(e) => update({ password: e.target.value })}
                placeholder={c.passwordPlaceholder}
                className="h-8 pr-8 font-mono text-xs"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </label>
          {draft.authMode === 'authorize' ? (
            <label className="block space-y-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">{c.twoFactorLabel}</span>
              <Input
                data-testid="inline-server-2fa"
                value={draft.twoFactor}
                disabled={busy}
                onChange={(e) => update({ twoFactor: e.target.value })}
                placeholder={c.twoFactorPlaceholder}
                className="h-8 font-mono text-xs"
              />
            </label>
          ) : (
            <>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{c.installTokenLabel}</span>
                <Input
                  data-testid="inline-server-install-token"
                  value={draft.installToken}
                  disabled={busy}
                  onChange={(e) => update({ installToken: e.target.value })}
                  placeholder={c.installTokenPlaceholder}
                  className="h-8 font-mono text-xs"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{c.metricDsnLabel}</span>
                <Input
                  data-testid="inline-server-metric-dsn"
                  value={draft.metricDsn}
                  disabled={busy}
                  onChange={(e) => update({ metricDsn: e.target.value })}
                  className="h-8 font-mono text-xs"
                />
              </label>
            </>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {connected && (
        <div className="flex items-center gap-1.5 text-xs text-[color:var(--workspace-status-good-text)]">
          <CircleCheck className="h-3.5 w-3.5 shrink-0" />
          <span>{fill(c.connectedOk, { name: connected.integration.name, count: connected.nodeCount })}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant={controlledDraft ? 'outline' : 'default'}
          data-testid="inline-server-submit"
          disabled={busy || !draft.endpoint.trim()}
          onClick={() => void handleConnect()}
          className="h-8 gap-1.5 text-xs"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
          {busy ? c.connectingBtn : c.connectBtn}
        </Button>
      </div>
    </div>
  )
}
