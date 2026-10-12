import { useEffect, useRef, useState } from 'react'
import { Cable, Copy, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVault } from '@/contexts/vault-context'
import { listHosts, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import {
  createMcpClient, DEFAULT_MCP_PERMISSIONS, getMcpStatus, revokeMcpClient, setMcpEnabled,
  formatMcpConfiguration, testMcpConnection,
  type McpClientTarget, type McpConfiguration, type McpPermissions, type McpStatus,
} from '@/lib/mcp'

export function McpSettingsSection() {
  const { t } = useT()
  const { activeVaultId } = useVault()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [hostIds, setHostIds] = useState<string[]>([])
  const [permissions, setPermissions] = useState<McpPermissions>({ ...DEFAULT_MCP_PERMISSIONS })
  const [name, setName] = useState('')
  const [target, setTarget] = useState<McpClientTarget>('codex')
  const [generated, setGenerated] = useState<{ clientId: string; configuration: McpConfiguration } | null>(null)
  const [testing, setTesting] = useState(false)
  const [diagnostic, setDiagnostic] = useState('')
  const generation = useRef({ value: 0 })
  const configuration = generated ? formatMcpConfiguration(generated.configuration, target) : ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [revokeId, setRevokeId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await getMcpStatus()
        if (!cancelled) setStatus(next)
      } catch (cause) {
        if (!cancelled) setError(String(cause))
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 10000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const scope = generation.current
    setHosts([])
    setHostIds([])
    scope.value++
    setGenerated(null)
    setDiagnostic('')
    setTesting(false)
    void listHosts(activeVaultId).then((next) => {
      if (!cancelled) setHosts(next)
    }).catch((cause) => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true; scope.value++ }
  }, [activeVaultId])

  async function action(run: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await run()
      setStatus(await getMcpStatus())
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  async function create() {
    const version = ++generation.current.value
    setGenerated(null)
    setDiagnostic('')
    await action(async () => {
      const result = await createMcpClient({ name: name.trim(), vaultId: activeVaultId, hostIds, permissions })
      if (version !== generation.current.value) return
      setGenerated({ clientId: result.client.id, configuration: result.configuration })
      setCopied(false)
      setName('')
    })
  }

  function discardConfiguration() {
    generation.current.value++
    setGenerated(null)
    setDiagnostic('')
    setTesting(false)
    setCopied(false)
  }

  async function checkConnection() {
    if (!generated || testing) return
    const version = generation.current.value
    setTesting(true)
    setDiagnostic('')
    try {
      const result = await testMcpConnection(generated.clientId, generated.configuration.mcpServers.shellbeam.env.SHELLBEAM_MCP_TOKEN)
      if (version === generation.current.value) setDiagnostic(t('mcp.checkPassed', { count: result.toolCount }))
    } catch {
      if (version === generation.current.value) setDiagnostic(t('mcp.checkFailed'))
    } finally {
      if (version === generation.current.value) setTesting(false)
    }
  }

  return (
    <section className="rounded-lg border p-4" data-testid="mcp-settings" data-tour="mcp-settings" data-tour-ready={Boolean(status || error)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold"><Cable className="h-4 w-4" />{t('mcp.title')}</h3>
        <label data-tour="mcp-toggle" className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={status?.enabled ?? false} disabled={busy || testing || !status?.desktopSupported}
            onChange={(event) => { void action(() => setMcpEnabled(event.target.checked)) }} />
          {t('mcp.enabled')}
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('mcp.description')}</p>
      {status && !status.desktopSupported && <p className="mt-2 text-sm text-muted-foreground">{t('mcp.desktopOnly')}</p>}
      {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
      {status?.desktopSupported && (
        <div className="mt-4 space-y-4">
          <div className="space-y-3 rounded-md border p-3">
            <h4 className="text-sm font-medium">{t('mcp.setupTitle')}</h4>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('mcp.clientType')}>
              {(['codex', 'claude', 'generic'] as const).map((clientTarget) => (
                <Button key={clientTarget} size="sm" variant={target === clientTarget ? 'default' : 'outline'}
                  aria-pressed={target === clientTarget} onClick={() => { setTarget(clientTarget); setCopied(false) }}>
                  {t(`mcp.target.${clientTarget}`)}
                </Button>
              ))}
            </div>
            <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
              <li>{t('mcp.setupAuthorize')}</li>
              <li className="whitespace-pre-line break-words">{t(`mcp.setup.${target}`)}</li>
              <li>{t('mcp.setupVerify')}</li>
            </ol>
            <p className="rounded border bg-muted/30 p-2 text-xs">{t('mcp.verifyPrompt')}</p>
            <p className="text-xs text-muted-foreground">{t('mcp.cloudWarning')}</p>
          </div>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground"><ShieldAlert className="h-4 w-4 shrink-0" />{t('mcp.securityTitle')}</p>
            <p className="mt-1">{t('mcp.securityDescription')}</p>
          </div>
          <label data-tour="mcp-client" className="block text-sm">
            {t('mcp.clientName')}
            <Input className="mt-1" value={name} maxLength={100} disabled={busy}
              placeholder={t('mcp.clientPlaceholder')} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset data-tour="mcp-hosts" disabled={busy} className="rounded-md border p-3">
            <legend className="px-1 text-xs font-medium">{t('mcp.servers')}</legend>
            <p className="mb-2 text-xs text-muted-foreground">{t('mcp.serversDescription')}</p>
            <div className="max-h-44 space-y-2 overflow-y-auto">
              {hosts.map((host) => (
                <label key={host.id} className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={hostIds.includes(host.id)} className="mt-0.5"
                    onChange={(event) => setHostIds((previous) => event.target.checked ? [...previous, host.id] : previous.filter((id) => id !== host.id))} />
                  <span className="min-w-0 break-words">{host.name} <span className="text-muted-foreground">{host.username}@{host.address}:{host.port}</span></span>
                </label>
              ))}
              {hosts.length === 0 && <p className="text-xs text-muted-foreground">{t('mcp.noServers')}</p>}
            </div>
          </fieldset>
          <fieldset data-tour="mcp-permissions" disabled={busy} className="space-y-2">
            <legend className="mb-2 text-xs text-muted-foreground">{t('mcp.permissionsDescription')}</legend>
            {(['refresh', 'execute', 'readFiles', 'writeFiles'] as const).map((permission) => (
              <label key={permission} className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={permissions[permission]} className="mt-0.5"
                  onChange={(event) => setPermissions((previous) => ({ ...previous, [permission]: event.target.checked }))} />
                <span>{t(`mcp.permission.${permission}`)}</span>
              </label>
            ))}
          </fieldset>
          <Button data-tour="mcp-create" size="sm" disabled={busy || testing || !name.trim() || hostIds.length === 0 || hostIds.length > 100} onClick={() => void create()}>
            {t('mcp.create')}
          </Button>
          {configuration && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium">{t(`mcp.target.${target}`)} · {target === 'codex' ? 'TOML' : 'JSON'}</p>
              <p className="text-xs text-muted-foreground">{t('mcp.configurationWarning')}</p>
              <textarea aria-label={t('mcp.configuration')} readOnly value={configuration} rows={10}
                className="w-full resize-y rounded-md border bg-muted/30 p-2 font-mono text-[11px]" spellCheck={false} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => {
                  void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch((cause) => setError(String(cause)))
                }}><Copy className="mr-1 h-3 w-3" />{t(copied ? 'mcp.copied' : 'mcp.copy')}</Button>
                <Button size="sm" variant="outline" disabled={busy || testing || !status.enabled} onClick={() => void checkConnection()}>{t(testing ? 'mcp.checking' : 'mcp.checkConnection')}</Button>
                <Button size="sm" variant="ghost" onClick={discardConfiguration}>{t('mcp.dismissConfiguration')}</Button>
              </div>
              {!status.enabled && <p className="text-xs text-muted-foreground">{t('mcp.checkEnableFirst')}</p>}
              <p className="text-xs text-muted-foreground">{t('mcp.checkScope')}</p>
              {diagnostic && <p role="status" className="text-xs">{diagnostic}</p>}
            </div>
          )}
          <div data-tour="mcp-clients" className="border-t pt-3">
            <h4 className="text-sm font-medium">{t('mcp.clients')}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{t('mcp.activeOperations', { count: status.activeOperations })}</p>
            {status.clients.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t('mcp.noClients')}</p>}
            {status.clients.map((client) => (
              <div key={client.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0 text-xs">
                  <p className="break-words font-medium">{client.name}</p>
                  <p className="break-all text-muted-foreground">{t('mcp.clientScope', { count: client.hosts.length, vault: client.vaultId })}</p>
                  <p className="text-muted-foreground">{Object.entries(client.permissions).filter(([, enabled]) => enabled).map(([key]) => t(`mcp.permission.${key}`)).join(' / ') || t('mcp.cachedOnly')}</p>
                  <p className="text-muted-foreground">{status.audit.some((entry) => entry.clientId === client.id && entry.outcome === 'accepted') ? t('mcp.requestObserved') : t('mcp.awaitingRequest')}</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                  if (revokeId !== client.id) { setRevokeId(client.id); return }
                  void action(async () => { await revokeMcpClient(client.id); setRevokeId(null); discardConfiguration() })
                }}>{t(revokeId === client.id ? 'mcp.confirmRevoke' : 'mcp.revoke')}</Button>
              </div>
            ))}
          </div>
          {status.audit.length > 0 && (
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium">{t('mcp.audit')}</summary>
              <div className="mt-2 max-h-48 space-y-2 overflow-auto">
                {status.audit.map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="break-words text-[11px] text-muted-foreground">
                    {new Date(entry.at).toLocaleString()} · {status.clients.find((client) => client.id === entry.clientId)?.name ?? entry.clientId} · {entry.tool} · {entry.outcome}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
