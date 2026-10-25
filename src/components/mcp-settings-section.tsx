import { useEffect, useRef, useState } from 'react'
import { Cable, Copy, ShieldCheck, ChevronRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useVault } from '@/contexts/vault-context'
import { listHosts, hostConnections, type HostProfile } from '@/lib/hosts'
import { listSnippets, type SnippetEntry } from '@/lib/snippets'
import { useT } from '@/lib/i18n'
import { McpHostPicker, type McpHostSelection } from '@/components/mcp-host-picker'
import { mcpAccessCopy } from '@/lib/locales/mcp-access'
import { cn } from '@/lib/utils'
import OperationsAuditCenter from '@/components/operations-audit-center'
import {
  createMcpClient, DEFAULT_MCP_PERMISSIONS, getMcpStatus, revokeMcpClient, setMcpEnabled,
  formatMcpConfiguration, testMcpConnection, mcpSnippetRevision,
  type McpClientTarget, type McpConfiguration, type McpPermissions, type McpStatus,
} from '@/lib/mcp'

export function McpSettingsSection() {
  const { activeVaultId } = useVault()
  return <McpAccessForm key={activeVaultId} activeVaultId={activeVaultId} />
}

function McpAccessForm({ activeVaultId }: { activeVaultId: string }) {
  const { t, locale } = useT()
  const c = mcpAccessCopy[locale]
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [selection, setSelection] = useState<McpHostSelection>({ hostIds: [], connectionIds: {} })
  const { hostIds, connectionIds } = selection
  const [loadingHosts, setLoadingHosts] = useState(true)
  const [step, setStep] = useState(0)
  const pendingAction = useRef(false)
  const statusEpoch = useRef(0)
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const [snippets, setSnippets] = useState<Array<SnippetEntry & { revision: string }>>([])
  const [snippetIds, setSnippetIds] = useState<string[]>([])
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
      if (pendingAction.current) return
      const epoch = ++statusEpoch.current
      try {
        const next = await getMcpStatus()
        if (!cancelled && epoch === statusEpoch.current) setStatus(next)
      } catch (cause) {
        if (!cancelled && epoch === statusEpoch.current) setError(String(cause))
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 10000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => { stepHeading.current?.focus() }, [step, generated])

  useEffect(() => {
    let cancelled = false
    const scope = generation.current
    setHosts([])
    setSelection({ hostIds: [], connectionIds: {} })
    setLoadingHosts(true)
    setSnippetIds([])
    scope.value++
    setGenerated(null)
    setDiagnostic('')
    setTesting(false)
    void listHosts(activeVaultId).then((next) => {
      if (!cancelled) { setHosts(next); setLoadingHosts(false) }
    }).catch((cause) => { if (!cancelled) { setError(String(cause)); setLoadingHosts(false) } })
    return () => { cancelled = true; scope.value++ }
  }, [activeVaultId])

  const sharingSnippets = !!(permissions.readSnippets || permissions.runSnippets)
  useEffect(() => {
    let cancelled = false
    setSnippets([])
    setSnippetIds([])
    if (sharingSnippets) void listSnippets(activeVaultId).then(async rows => {
      const next = await Promise.all(rows.map(async row => ({ ...row, revision: await mcpSnippetRevision(row.command) })))
      if (!cancelled) setSnippets(next)
    }).catch(cause => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [activeVaultId, sharingSnippets])

  async function action(run: () => Promise<void>) {
    if (pendingAction.current) return
    pendingAction.current = true
    ++statusEpoch.current
    setBusy(true)
    setError('')
    try {
      await run()
      setStatus(await getMcpStatus())
    } catch (cause) { setError(String(cause)) }
    finally { pendingAction.current = false; setBusy(false) }
  }

  async function create() {
    if (pendingAction.current || !validScope || !validPermissions || generated) return
    const version = ++generation.current.value
    setGenerated(null)
    setDiagnostic('')
    await action(async () => {
      const result = await createMcpClient({ name: name.trim(), vaultId: activeVaultId, hostIds, permissions,
        connectionIds: Object.fromEntries(hostIds.map(id => [id, connectionIds[id] ?? []])),
        snippets: sharingSnippets ? snippets.filter(row => snippetIds.includes(row.id)).map(({ id, revision }) => ({ id, revision })) : [],
      })
      if (version !== generation.current.value) return
      setGenerated({ clientId: result.client.id, configuration: result.configuration })
      setCopied(false)
    })
  }

  function discardConfiguration() {
    generation.current.value++
    setGenerated(null)
    setDiagnostic('')
    setTesting(false)
    setCopied(false)
    setStep(0)
    setSelection({ hostIds: [], connectionIds: {} })
    setPermissions({ ...DEFAULT_MCP_PERMISSIONS })
    setSnippetIds([])
    setName('')
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

  const selectedHosts = hosts.filter(host => hostIds.includes(host.id))
  const accountCount = selectedHosts.reduce((total, host) => total + (connectionIds[host.id]?.length ?? 0), 0)
  const remote = permissions.refresh || permissions.inspect || permissions.readFiles || permissions.writeFiles || permissions.execute || permissions.runSnippets
  const nameTooLong = new TextEncoder().encode(name.trim()).length > 100
  const validScope = !loadingHosts && !!name.trim() && !nameTooLong && hostIds.length > 0 && hostIds.length <= 100 && selectedHosts.length === hostIds.length
  const validPermissions = (!remote || accountCount > 0) && (!sharingSnippets || (snippetIds.length > 0 && snippetIds.length <= 100 && snippetIds.every(id => snippets.some(row => row.id === id))))
  const selectedPermissions = (Object.keys(c.permission) as Array<keyof McpPermissions>).filter(key => permissions[key])
  const disabled = busy || testing
  const typeSelector = <div className="flex flex-wrap gap-2" role="group" aria-label={t('mcp.clientType')}>
    {(['codex', 'claude', 'generic'] as const).map(clientTarget => <Button key={clientTarget} size="sm" variant={target === clientTarget ? 'secondary' : 'ghost'} disabled={disabled} aria-pressed={target === clientTarget} onClick={() => { setTarget(clientTarget); setCopied(false) }}>{t(`mcp.target.${clientTarget}`)}</Button>)}
  </div>
  const reviewHosts = <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-xs">
    {selectedHosts.map(host => <li key={host.id} className="space-y-1 p-3"><p className="font-medium">{host.name}</p><p className="break-all text-muted-foreground">{hostConnections(host).filter(conn => connectionIds[host.id]?.includes(conn.id)).map(conn => `${conn.label} · ${conn.username}@${conn.address}:${conn.port}`).join(' / ') || c.cacheOnly}</p></li>)}
  </ul>

  return <section className="min-w-0 rounded-xl border p-4 sm:p-5" data-testid="mcp-settings" data-tour="mcp-settings" data-tour-ready={Boolean(status || error)}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Cable aria-hidden className="h-5 w-5 text-muted-foreground" /><h3 className="font-semibold">{t('mcp.title')}</h3>{status && <span className={cn('rounded-full px-2 py-1 text-[11px]', status.running ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>{status.running ? c.running : c.stopped}</span>}</div>
      <label data-tour="mcp-toggle" className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox  checked={status?.enabled ?? false} disabled={disabled || !status?.desktopSupported} onChange={event => { void action(() => setMcpEnabled(event.target.checked)) }} />{t('mcp.enabled')}</label>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">{c.intro}</p>
    {status && !status.desktopSupported && <p className="mt-3 text-sm text-muted-foreground">{t('mcp.desktopOnly')}</p>}
    {error && <p role="alert" className="mt-3 break-words text-xs text-red-500">{error}</p>}
    {status?.desktopSupported && <div className="mt-5 space-y-5">
      <div className="min-w-0 rounded-xl border bg-background">
        <div className="border-b p-4">
          <h4 ref={stepHeading} tabIndex={-1} className="text-sm font-semibold outline-none">{generated ? c.generated : c.newClient}</h4>
          {!generated && <nav aria-label={c.newClient} className="mt-3 flex flex-wrap gap-2">
            {c.steps.map((label, index) => <button key={label} type="button" disabled={disabled || index > step} aria-label={label} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-xs disabled:cursor-default', step === index ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground')}><span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px]', step === index ? 'bg-primary text-white' : 'bg-muted')}>{index < step ? <Check aria-hidden className="h-3 w-3" /> : index + 1}</span>{label}</button>)}
          </nav>}
          {generated && <p className="mt-1 text-xs text-muted-foreground">{c.generatedHint}</p>}
        </div>
        <div className="space-y-5 p-4">
          {!generated && step === 0 && <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <label data-tour="mcp-client" className="min-w-0 flex-[1_1_240px] text-sm font-medium">{t('mcp.clientName')}<Input className="mt-2" value={name} maxLength={100} disabled={disabled} placeholder={t('mcp.clientPlaceholder')} onChange={event => setName(event.target.value)} /></label>
              {typeSelector}
            </div>
            {nameTooLong && <p role="alert" className="text-xs text-red-500">{c.nameTooLong}</p>}
            <McpHostPicker hosts={hosts} selection={selection} onChange={setSelection} disabled={disabled} loading={loadingHosts} />
          </>}
          {!generated && step === 1 && <>
            <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3"><ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="text-sm font-medium">{c.included}</p><p className="mt-1 text-xs text-muted-foreground">{c.optional}</p></div></div>
            <fieldset data-tour="mcp-permissions" disabled={disabled} className="space-y-5">
              {([{ title: c.readTitle, keys: ['refresh', 'inspect', 'readFiles'] }, { title: c.snippetTitle, keys: ['readSnippets', 'runSnippets'] }, { title: c.writeTitle, keys: ['execute', 'writeFiles', 'recordDeployments', 'manageAlerts'] }] as Array<{ title: string; keys: Array<keyof McpPermissions> }>).map(group => <div key={group.title}>
                <h5 className="mb-2 text-xs font-medium text-muted-foreground">{group.title}</h5>
                <div className="grid gap-2 lg:grid-cols-2">{group.keys.map(key => <label key={key} className={cn('flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3', permissions[key] && 'border-primary/40 bg-primary/5')}>
                  <Checkbox  aria-label={c.permission[key][0]} checked={!!permissions[key]} onChange={event => setPermissions(previous => ({ ...previous, [key]: event.target.checked }))} />
                  <span className="min-w-0"><span className="block text-sm font-medium">{c.permission[key][0]}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{c.permission[key][1]}</span></span>
                </label>)}</div>
              </div>)}
            </fieldset>
            {remote && accountCount === 0 && <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">{c.sshNeeded}</p>}
            {remote && accountCount > 0 && selectedHosts.some(host => !connectionIds[host.id]?.length) && <p className="text-xs text-muted-foreground">{c.partialSsh}</p>}
            {sharingSnippets && <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">{t('mcp.snippets')}</legend><p className="text-xs text-muted-foreground">{c.snippetHint}</p>
              <div className="max-h-80 space-y-3 overflow-y-auto">{snippets.map(row => <div key={row.id} className="space-y-2">
                <label className="flex items-start gap-2 text-sm"><Checkbox  checked={snippetIds.includes(row.id)} onChange={event => setSnippetIds(previous => event.target.checked ? [...previous, row.id] : previous.filter(id => id !== row.id))} /><span>{row.name}</span></label>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-xs">{row.command}</pre>
                <details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">{c.snippetDetails}</summary><p className="mt-1 break-all font-mono">SHA-256: {row.revision}</p></details>
              </div>)}{!snippets.length && <p className="text-xs text-muted-foreground">{t('mcp.noSnippets')}</p>}</div>
            </fieldset>}
            {permissions.execute && <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">{c.commandWarning}</p>}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{c.securityDetails}</summary><p className="mt-2 leading-relaxed">{t('mcp.securityDescription')}</p></details>
          </>}
          {!generated && step === 2 && <>
            <div><h5 className="break-words font-medium">{name} <span className="text-sm font-normal text-muted-foreground">· {t(`mcp.target.${target}`)}</span></h5><p className="mt-1 text-xs text-muted-foreground">{c.reviewHint}</p></div>
            <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-md bg-muted px-3 py-2">{c.hosts} · {hostIds.length}</span><span className="rounded-md bg-muted px-3 py-2">{c.accounts} · {accountCount}</span>{sharingSnippets && <span className="rounded-md bg-muted px-3 py-2">{t('mcp.snippets')} · {snippetIds.length}</span>}</div>
            {reviewHosts}
            <div><p className="mb-2 text-xs font-medium text-muted-foreground">{c.capabilities}</p><div className="flex flex-wrap gap-2">{selectedPermissions.length ? selectedPermissions.map(key => <span key={key} className="rounded-md border px-2 py-1 text-xs">{c.permission[key][0]}</span>) : <span className="text-sm">{c.noExtra}</span>}</div></div>
            {sharingSnippets && <ul className="space-y-1 text-xs">{snippets.filter(row => snippetIds.includes(row.id)).map(row => <li key={row.id}><details><summary className="cursor-pointer">{row.name}</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-2">{row.command}</pre><p className="mt-1 break-all font-mono text-muted-foreground">SHA-256: {row.revision}</p></details></li>)}</ul>}
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground"><p>{c.reviewScope} {c.staleScope}</p><p>{c.dataWarning}</p></div>
            {permissions.execute && <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">{c.commandWarning}</p>}
            {permissions.manageAlerts && <p className="text-xs text-muted-foreground">{c.permission.manageAlerts[1]}</p>}
          </>}
          {generated && <>
            {typeSelector}
            <p className="text-xs text-amber-600 dark:text-amber-400">{c.tokenWarning}</p>
            <textarea aria-label={t('mcp.configuration')} readOnly value={configuration} rows={8} className="w-full min-w-0 resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[11px]" spellCheck={false} />
            <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { const version = generation.current.value; void navigator.clipboard.writeText(configuration).then(() => { if (version === generation.current.value) setCopied(true) }).catch(cause => { if (version === generation.current.value) setError(String(cause)) }) }}><Copy aria-hidden className="mr-2 h-3 w-3" />{t(copied ? 'mcp.copied' : 'mcp.copy')}</Button><Button size="sm" variant="outline" disabled={busy || testing || !status.enabled} onClick={() => void checkConnection()}>{t(testing ? 'mcp.checking' : 'mcp.checkConnection')}</Button></div>
            <p className="text-xs text-muted-foreground">{c.checkScope}</p>
            {diagnostic && <p role="status" className="text-xs">{diagnostic}</p>}
            <details className="rounded-lg border p-3 text-xs"><summary className="cursor-pointer font-medium">{c.configHelp}</summary><p className="mt-3 break-words leading-relaxed">{t(`mcp.setup.${target}`)}</p><p className="mt-2 leading-relaxed">{c.verify}</p><p className="mt-2 leading-relaxed text-muted-foreground">{t('mcp.configurationWarning')}</p></details>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{c.protocolHelp}</summary><p className="mt-2 leading-relaxed">{t('mcp.setupVerify')}</p><p className="mt-2 leading-relaxed">{t('mcp.cloudWarning')}</p></details>
            <Button size="sm" variant="ghost" onClick={discardConfiguration}>{c.done}</Button>
          </>}
        </div>
        {!generated && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 p-4">
          <p className="text-xs text-muted-foreground">{c.selected} {hostIds.length} · {selectedPermissions.length ? `${c.capabilities} ${selectedPermissions.length}` : c.cacheOnly}</p>
          <div className="flex gap-2">{step > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setStep(step - 1)}>{c.back}</Button>}{step < 2 ? <Button size="sm" disabled={disabled || !validScope || (step === 1 && !validPermissions)} onClick={() => setStep(step + 1)}>{step === 0 ? c.next : c.review}<ChevronRight aria-hidden className="ml-1 h-3 w-3" /></Button> : <Button data-tour="mcp-create" size="sm" disabled={disabled || !validScope || !validPermissions} onClick={() => void create()}>{t('mcp.create')}</Button>}</div>
        </div>}
      </div>
      {!status.enabled && <p className="text-xs text-muted-foreground">{c.offline}</p>}
      <div data-tour="mcp-clients" className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-medium">{t('mcp.clients')} <span className="ml-1 text-muted-foreground">{status.clients.length}</span></h4>
        {!status.clients.length && <p className="text-xs text-muted-foreground">{t('mcp.noClients')}</p>}
        {status.clients.map(client => <div key={client.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{client.name}</p><p className="mt-1 text-xs text-muted-foreground">{client.hosts.length} {c.hosts} · {status.audit.some(entry => entry.clientId === client.id && entry.outcome === 'accepted') ? c.observed : c.waiting}</p></div><div className="flex gap-2">{revokeId === client.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevokeId(null)}>{c.cancel}</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={() => { if (revokeId !== client.id) { setRevokeId(client.id); return } void action(async () => { await revokeMcpClient(client.id); setRevokeId(null); if (generated?.clientId === client.id) discardConfiguration() }) }}>{t(revokeId === client.id ? 'mcp.confirmRevoke' : 'mcp.revoke')}</Button></div></div>
          {revokeId === client.id && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{c.revokeHint}</p>}
          <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{c.clientDetails}</summary><p className="mt-2 break-all">{t('mcp.clientScope', { count: client.hosts.length, vault: client.vaultId })}</p><p className="mt-1">{Object.entries(client.permissions).filter(([, enabled]) => enabled).map(([key]) => c.permission[key as keyof McpPermissions]?.[0] ?? key).join(' / ') || c.noExtra}</p><ul className="mt-2 space-y-1">{client.hosts.map(grant => <li key={grant.id} className="break-all">{client.vaultId === activeVaultId ? hosts.find(host => host.id === grant.id)?.name ?? grant.id : grant.id}{grant.connections && ` · ${grant.connections.length} ${c.accounts}`}</li>)}</ul></details>
        </div>)}
      </div>
      <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">{c.auditTitle}</summary><p className="mt-3 text-xs text-muted-foreground">{t('mcp.activeOperations', { count: status.activeOperations })}</p>{status.audit.length > 0 && <div className="mt-3 max-h-48 space-y-2 overflow-auto">{status.audit.map((entry, index) => <p key={`${entry.at}-${index}`} className="break-words text-[11px] text-muted-foreground">{new Date(entry.at).toLocaleString()} · {status.clients.find(client => client.id === entry.clientId)?.name ?? entry.clientId} · {entry.tool} · {entry.outcome}</p>)}</div>}<OperationsAuditCenter source="mcp" vaultId={activeVaultId} limit={100} className="mt-3 border-t pt-3" /></details>
    </div>}
  </section>
}
