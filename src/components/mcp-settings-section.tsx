import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Bot, Cable, Check, ChevronRight, Copy, Eye, EyeOff, Info, KeyRound, List, Plus, RefreshCw, ShieldCheck, Sparkles, X, type LucideIcon } from 'lucide-react'
import { AIProviderLogo } from '@/components/ai-provider-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useVault } from '@/contexts/vault-context'
import { listHosts, hostConnections, type HostProfile } from '@/lib/hosts'
import { listSnippets, type SnippetEntry } from '@/lib/snippets'
import { useT } from '@/lib/i18n'
import { McpHostPicker, type McpHostSelection } from '@/components/mcp-host-picker'
import { mcpAccessCopy } from '@/lib/locales/mcp-access'
import { aiMcpSettingsCopy } from '@/lib/locales/ai-mcp-settings-v3'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import OperationsAuditCenter from '@/components/operations-audit-center'
import type { LocalAgentId } from '@/lib/agents'
import type { AIBrandId } from '@/lib/ai-brand'
import {
  connectMcpAgents, createMcpClient, DEFAULT_MCP_PERMISSIONS, detectMcpAgents, getMcpStatus, revokeMcpClient, setMcpEnabled,
  formatMcpConfiguration, testMcpConnection, mcpSnippetRevision,
  type DetectedLocalAgent, type McpClientTarget, type McpConfiguration, type McpConnectAgentResult, type McpPermissions, type McpStatus,
} from '@/lib/mcp'

type QuickPreset = 'cache' | 'readOnly' | 'full'
type McpViewTab = 'agents' | 'manual' | 'clients' | 'audit'

function permissionsForPreset(preset: QuickPreset): McpPermissions {
  if (preset === 'cache') return { ...DEFAULT_MCP_PERMISSIONS }
  if (preset === 'readOnly') {
    return {
      ...DEFAULT_MCP_PERMISSIONS,
      refresh: true,
      inspect: true,
      readFiles: true,
    }
  }
  return {
    ...DEFAULT_MCP_PERMISSIONS,
    refresh: true,
    inspect: true,
    readFiles: true,
    writeFiles: true,
    execute: true,
    recordDeployments: true,
    manageAlerts: true,
  }
}

function shortenConfigPath(path: string | null): string {
  if (!path) return ''
  return path
    .replace(/^\/Users\/[^/]+\//, '~/')
    .replace(/^\/home\/[^/]+\//, '~/')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '~\\')
}

export function McpSettingsSection({ initialTab }: { initialTab?: McpViewTab } = {}) {
  const { activeVaultId } = useVault()
  return <McpAccessForm key={`${activeVaultId}:${initialTab ?? 'auto'}`} activeVaultId={activeVaultId} initialTab={initialTab} />
}

function McpAccessForm({ activeVaultId, initialTab }: { activeVaultId: string; initialTab?: McpViewTab }) {
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
  const [detectedAgents, setDetectedAgents] = useState<DetectedLocalAgent[]>([])
  const [scanningAgents, setScanningAgents] = useState(false)
  const [quickPreset, setQuickPreset] = useState<QuickPreset>('readOnly')
  const [quickResults, setQuickResults] = useState<McpConnectAgentResult[] | null>(null)
  const [chosenTab, setChosenTab] = useState<McpViewTab | null>(initialTab ?? null)

  const refreshDetectedAgents = useCallback(async () => {
    setScanningAgents(true)
    try {
      const list = await detectMcpAgents()
      setDetectedAgents(list)
    } catch {
      // Non-fatal: desktop fallback keeps manual setup usable.
    } finally {
      setScanningAgents(false)
    }
  }, [])

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
    void refreshDetectedAgents()
    const timer = window.setInterval(() => { void load() }, 10000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [refreshDetectedAgents])

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
    setQuickResults(null)
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
      void refreshDetectedAgents()
    } catch (cause) { setError(String(cause)) }
    finally { pendingAction.current = false; setBusy(false) }
  }

  const installedAgents = useMemo(
    () => detectedAgents.filter(agent => agent.installed),
    [detectedAgents],
  )
  const uninstalledAgents = useMemo(
    () => detectedAgents.filter(agent => !agent.installed),
    [detectedAgents],
  )
  const installedAgentIds = useMemo(
    () => installedAgents.map(agent => agent.id),
    [installedAgents],
  )
  const connectedAgentCount = useMemo(
    () => detectedAgents.filter(agent => Boolean(agent.activeClientId && agent.mcpConfigured)).length,
    [detectedAgents],
  )
  const hasLocalAgents = detectedAgents.length > 0
  const activeTab: McpViewTab = chosenTab ?? (hasLocalAgents ? 'agents' : 'manual')

  const quickHosts = useMemo(() => hosts.slice(0, 100), [hosts])
  const quickHasSshHost = useMemo(
    () => quickHosts.some(host => hostConnections(host).length > 0),
    [quickHosts],
  )
  const quickNeedsSsh = quickPreset !== 'cache'
  const quickHostsReady = !busy && !loadingHosts && quickHosts.length > 0 && (!quickNeedsSsh || quickHasSshHost)
  const quickCanConnectAll = quickHostsReady && installedAgentIds.length > 0

  async function quickConnect(agentIds: LocalAgentId[]) {
    if (!quickHostsReady || agentIds.length === 0) return
    setQuickResults(null)
    await action(async () => {
      const quickHostIds = quickHosts.map(host => host.id)
      const res = await connectMcpAgents({
        agentIds,
        vaultId: activeVaultId,
        hostIds: quickHostIds,
        permissions: permissionsForPreset(quickPreset),
        enableMcp: true,
      })
      setQuickResults(res.results)
    })
  }

  async function create() {
    if (pendingAction.current || !validScope || !validPermissions || generated) return
    const version = ++generation.current.value
    setGenerated(null)
    setQuickResults(null)
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
    setQuickResults(null)
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
  const v = aiMcpSettingsCopy[locale]
  const typeSelector = <div className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1" role="group" aria-label={t('mcp.clientType')}>
    {(['codex', 'claude', 'generic'] as const).map(clientTarget => <button key={clientTarget} type="button" disabled={disabled} aria-pressed={target === clientTarget} onClick={() => { setTarget(clientTarget); setCopied(false) }}
      className={cn('rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50', target === clientTarget ? 'bg-[var(--workspace-surface-800)] font-semibold text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>{t(`mcp.target.${clientTarget}`)}</button>)}
  </div>
  const note = (text: string, Icon: LucideIcon = Info, tone: 'muted' | 'warn' = 'muted') => <p className={cn('flex items-start gap-2 text-xs leading-relaxed', tone === 'warn' ? 'text-[var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-muted)]')}><Icon aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tone === 'muted' && 'text-[var(--workspace-text-subtle)]')} />{text}</p>
  const banner = (text: string, tone: 'warn' | 'info', Icon: LucideIcon) => <p className={cn('flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed', tone === 'warn' ? 'border-[color:var(--workspace-status-warn)] bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]' : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}><Icon aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{text}</p>
  const chip = (text: string, key?: string) => <span key={key} className="rounded bg-[var(--workspace-accent-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-accent-text)]">{text}</span>
  const reviewHosts = <div className="overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)]">
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-3 py-2 text-[11px] text-[var(--workspace-text-subtle)]"><span>{v.hostCol}</span><span>{v.accountCol}</span></div>
    <ul className="max-h-48 divide-y divide-[color:var(--workspace-border-soft)] overflow-y-auto text-xs">
      {selectedHosts.map(host => <li key={host.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-3 py-2"><p className="break-words font-medium text-[var(--workspace-text-strong)]">{host.name}</p><p className="break-all font-mono text-[var(--workspace-text)]">{hostConnections(host).filter(conn => connectionIds[host.id]?.includes(conn.id)).map(conn => `${conn.label} · ${conn.username}@${conn.address}:${conn.port}`).join(' / ') || c.cacheOnly}</p></li>)}
    </ul>
  </div>
  const reviewSummary = <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-xs">
    <dt className="text-[var(--workspace-text-subtle)]">{v.clientLabel}</dt><dd className="break-words text-[var(--workspace-text-strong)]">{name} · {t(`mcp.target.${target}`)}</dd>
    <dt className="text-[var(--workspace-text-subtle)]">{v.hostsLabel}</dt><dd className="text-[var(--workspace-text-strong)]">{fill(v.hostsSummary, { hosts: hostIds.length, accounts: accountCount })}</dd>
    <dt className="text-[var(--workspace-text-subtle)]">{v.capabilitiesLabel}</dt><dd className="flex flex-wrap gap-1.5">{selectedPermissions.length ? selectedPermissions.map(key => chip(c.permission[key][0], key)) : <span className="text-[var(--workspace-text)]">{c.noExtra}</span>}</dd>
    {sharingSnippets && <><dt className="text-[var(--workspace-text-subtle)]">{v.snippetsLabel}</dt><dd className="text-[var(--workspace-text-strong)]">{fill(v.snippetsSummary, { count: snippetIds.length })}</dd></>}
  </dl>
  const stepState = (index: number) => generated || index < step ? 'done' : index === step ? 'current' : 'todo'

  const renderAgentRow = (agent: DetectedLocalAgent) => {
    const isConnected = Boolean(agent.activeClientId && agent.mcpConfigured)
    const activeClientId = agent.activeClientId
    const confirmingDisconnect = Boolean(activeClientId && revokeId === activeClientId)
    return (
      <div key={agent.id} data-testid={`mcp-agent-row-${agent.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)]">
            <AIProviderLogo brand={agent.id as AIBrandId} className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-[var(--workspace-text-strong)]">{agent.name}</span>
              {isConnected && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--workspace-status-good-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--workspace-status-good-text)]">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--workspace-status-good)]" />
                  {c.quickConnected}
                </span>
              )}
            </div>
            {agent.configPath && (
              <p className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" title={agent.configPath}>
                {shortenConfigPath(agent.configPath)}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isConnected && activeClientId ? (
            confirmingDisconnect ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevokeId(null)}>
                  {c.cancel}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)]"
                  disabled={busy}
                  onClick={() => {
                    void action(async () => {
                      await revokeMcpClient(activeClientId)
                      setRevokeId(null)
                      if (generated?.clientId === activeClientId) discardConfiguration()
                    })
                  }}
                >
                  {c.quickConfirmDisconnect}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" disabled={!quickHostsReady} onClick={() => void quickConnect([agent.id])}>
                  {c.quickSyncOne}
                </Button>
                <Button size="sm" variant="ghost" className="text-[var(--workspace-text-muted)] hover:text-[var(--workspace-status-bad-text)]" disabled={busy} onClick={() => setRevokeId(activeClientId)}>
                  {c.quickDisconnect}
                </Button>
              </>
            )
          ) : (
            <Button size="sm" variant="outline" disabled={!quickHostsReady} onClick={() => void quickConnect([agent.id])}>
              {agent.installed ? c.quickConnectOne : c.quickPreconfigure}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const manualWizardCard = (
    <div className="sb-card min-w-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <h4 ref={stepHeading} tabIndex={-1} className="sr-only">{generated ? c.generated : c.newClient}</h4>
        <nav aria-label={c.newClient} className="flex min-w-0 flex-wrap items-center gap-2">
          {c.steps.map((label, index) => { const state = stepState(index); return <Fragment key={label}>
            {index > 0 && <span aria-hidden className="hidden h-px w-8 bg-[var(--workspace-border-strong)] sm:block" />}
            <button type="button" disabled={!!generated || disabled || index > step} aria-label={label} aria-current={(generated ? index === 2 : step === index) ? 'step' : undefined} onClick={() => setStep(index)}
              className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-xs disabled:cursor-default', state === 'todo' ? 'text-[var(--workspace-text-muted)]' : 'text-[var(--workspace-text-strong)]', (generated ? index === 2 : state === 'current') && 'font-semibold')}>
              <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px]', state === 'done' ? 'bg-[var(--workspace-status-good)] text-white' : state === 'current' ? 'bg-[color:var(--workspace-primary-500)] text-white' : 'border border-[color:var(--workspace-border-strong)]')}>{state === 'done' ? <Check aria-hidden className="h-3 w-3" /> : index + 1}</span>{label}
            </button>
          </Fragment> })}
        </nav>
        {generated && <span className="ml-auto text-xs font-medium text-[var(--workspace-status-good-text)]">{c.generated}</span>}
      </div>
      <div className="p-4">
        {!generated && step === 0 && <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="min-w-0 space-y-4">
            <label data-tour="mcp-client" className="block text-xs font-medium text-[var(--workspace-text)]">{t('mcp.clientName')}<Input className="mt-1.5" value={name} maxLength={100} disabled={disabled} placeholder={t('mcp.clientPlaceholder')} onChange={event => setName(event.target.value)} /></label>
            <p className="-mt-2.5 text-xs text-[var(--workspace-text-subtle)]">{v.nameLimit}</p>
            {nameTooLong && <p role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{c.nameTooLong}</p>}
            <div><p className="mb-1.5 text-xs font-medium text-[var(--workspace-text)]">{v.clientType}</p>{typeSelector}</div>
            <div className="space-y-2">{note(v.hostNote)}{note(v.monitorNote, Eye)}</div>
          </div>
          <McpHostPicker hosts={hosts} selection={selection} onChange={setSelection} disabled={disabled} loading={loadingHosts} />
        </div>}
        {!generated && step === 1 && <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <fieldset data-tour="mcp-permissions" disabled={disabled} className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)]">
            <legend className="sr-only">{c.capabilities}</legend>
            {([{ title: c.readTitle, keys: ['refresh', 'inspect', 'readFiles'] }, { title: c.snippetTitle, keys: ['readSnippets', 'runSnippets'] }, { title: c.writeTitle, keys: ['execute', 'writeFiles', 'recordDeployments', 'manageAlerts'] }] as Array<{ title: string; keys: Array<keyof McpPermissions> }>).map(group => <div key={group.title}>
              <h5 className="border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-4 py-2 text-xs font-semibold text-[var(--workspace-text)]">{group.title}</h5>
              <div className="divide-y divide-[color:var(--workspace-border-soft)] border-b border-[color:var(--workspace-border-soft)]">{group.keys.map(key => { const risky = key === 'execute' || key === 'writeFiles'; return <label key={key} className={cn('flex min-w-0 cursor-pointer items-start gap-3 px-4 py-2.5', permissions[key] && 'bg-[var(--workspace-accent-subtle)]')}>
                <Checkbox aria-label={c.permission[key][0]} className="mt-0.5" checked={!!permissions[key]} onChange={event => setPermissions(previous => ({ ...previous, [key]: event.target.checked }))} />
                <span className="min-w-0"><span className={cn('block text-sm font-medium', risky ? 'text-[var(--workspace-status-bad-text)]' : 'text-[var(--workspace-text-strong)]')}>{c.permission[key][0]}</span><span className="mt-0.5 block text-xs leading-relaxed text-[var(--workspace-text-muted)]">{c.permission[key][1]}</span></span>
              </label> })}</div>
            </div>)}
          </fieldset>
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] p-3"><ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-good-text)]" /><div><p className="text-sm font-medium text-[var(--workspace-text-strong)]">{c.included}</p><p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{c.optional}</p></div></div>
            {banner(v.riskBanner, 'warn', AlertTriangle)}
            {permissions.execute && <p className="rounded-lg bg-[var(--workspace-status-warn-bg)] p-3 text-xs leading-relaxed text-[var(--workspace-status-warn-text)]">{c.commandWarning}</p>}
            {remote && accountCount === 0 && <p role="alert" className="text-sm text-[var(--workspace-status-warn-text)]">{c.sshNeeded}</p>}
            {remote && accountCount > 0 && selectedHosts.some(host => !connectionIds[host.id]?.length) && banner(c.partialSsh, 'info', KeyRound)}
            {sharingSnippets && <fieldset disabled={disabled} className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)]">
              <legend className="sr-only">{t('mcp.snippets')}</legend>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5"><p className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('mcp.snippets')} <span className="ml-1 text-xs font-normal text-[var(--workspace-text-muted)]">{v.snippetPinned}</span></p><span className="text-[11px] text-[var(--workspace-text-muted)]">{fill(v.snippetCount, { count: snippetIds.length })}</span></div>
              <p className="px-4 pt-2.5 text-xs text-[var(--workspace-text-muted)]">{c.snippetHint}</p>
              <div className="max-h-80 divide-y divide-[color:var(--workspace-border-soft)] overflow-y-auto">{snippets.map(row => <div key={row.id} className="space-y-1.5 px-4 py-2.5">
                <label className="flex items-start gap-2 text-sm font-medium text-[var(--workspace-text-strong)]"><Checkbox className="mt-0.5" checked={snippetIds.includes(row.id)} onChange={event => setSnippetIds(previous => event.target.checked ? [...previous, row.id] : previous.filter(id => id !== row.id))} /><span>{row.name}</span></label>
                <pre className="ml-6 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--workspace-text-muted)]">{row.command}</pre>
                <details className="ml-6 text-[11px] text-[var(--workspace-text-subtle)]"><summary className="cursor-pointer">{c.snippetDetails}</summary><p className="mt-1 break-all font-mono">SHA-256: {row.revision}</p></details>
              </div>)}{!snippets.length && <p className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{t('mcp.noSnippets')}</p>}</div>
            </fieldset>}
            <details className="text-xs text-[var(--workspace-text-muted)]"><summary className="cursor-pointer">{c.securityDetails}</summary><p className="mt-2 leading-relaxed">{t('mcp.securityDescription')}</p></details>
          </div>
        </div>}
        {!generated && step === 2 && <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            {reviewSummary}
            {reviewHosts}
            {sharingSnippets && <ul className="space-y-1 text-xs">{snippets.filter(row => snippetIds.includes(row.id)).map(row => <li key={row.id}><details><summary className="cursor-pointer text-[var(--workspace-text)]">{row.name}</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-[var(--workspace-surface-950)] p-2 font-mono">{row.command}</pre><p className="mt-1 break-all font-mono text-[var(--workspace-text-muted)]">SHA-256: {row.revision}</p></details></li>)}</ul>}
          </div>
          <div className="min-w-0 space-y-3">
            <div><p className="mb-1.5 text-xs font-medium text-[var(--workspace-text)]">{v.clientType}</p>{typeSelector}</div>
            {note(c.reviewHint)}
            <div className="space-y-1 text-xs leading-relaxed text-[var(--workspace-status-warn-text)]"><p>{c.reviewScope} {c.staleScope}</p><p>{c.dataWarning}</p></div>
            {permissions.execute && <p className="rounded-lg bg-[var(--workspace-status-warn-bg)] p-3 text-xs text-[var(--workspace-status-warn-text)]">{c.commandWarning}</p>}
            {permissions.manageAlerts && <p className="text-xs text-[var(--workspace-text-muted)]">{c.permission.manageAlerts[1]}</p>}
          </div>
        </div>}
        {generated && <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            {reviewSummary}
            {reviewHosts}
            {note(`${c.reviewScope} ${c.staleScope}`, AlertTriangle, 'warn')}
          </div>
          <div className="min-w-0 space-y-3">
            {typeSelector}
            {banner(c.tokenWarning, 'warn', EyeOff)}
            <p className="text-xs text-[var(--workspace-text-muted)]">{c.generatedHint}</p>
            <textarea aria-label={t('mcp.configuration')} readOnly value={configuration} rows={8} className="w-full min-w-0 resize-y rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-3 font-mono text-[11px] text-[var(--workspace-text)]" spellCheck={false} />
            <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => { const version = generation.current.value; void navigator.clipboard.writeText(configuration).then(() => { if (version === generation.current.value) setCopied(true) }).catch(cause => { if (version === generation.current.value) setError(String(cause)) }) }}><Copy aria-hidden className="mr-2 h-3 w-3" />{t(copied ? 'mcp.copied' : 'mcp.copy')}</Button><Button size="sm" variant="outline" disabled={busy || testing || !status?.enabled} onClick={() => void checkConnection()}><Cable aria-hidden className="mr-2 h-3 w-3" />{t(testing ? 'mcp.checking' : 'mcp.checkConnection')}</Button></div>
            {diagnostic && <p role="status" className="text-xs text-[var(--workspace-text)]">{diagnostic}</p>}
            {note(c.checkScope)}
            <details className="rounded-lg border border-[color:var(--workspace-border-soft)] p-3 text-xs"><summary className="cursor-pointer font-medium text-[var(--workspace-text)]">{c.configHelp}</summary><p className="mt-3 break-words leading-relaxed">{t(`mcp.setup.${target}`)}</p><p className="mt-2 leading-relaxed">{c.verify}</p><p className="mt-2 leading-relaxed text-[var(--workspace-text-muted)]">{t('mcp.configurationWarning')}</p></details>
            <details className="text-xs text-[var(--workspace-text-muted)]"><summary className="cursor-pointer">{c.protocolHelp}</summary><p className="mt-2 leading-relaxed">{t('mcp.setupVerify')}</p><p className="mt-2 leading-relaxed">{t('mcp.cloudWarning')}</p></details>
          </div>
        </div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
        {generated ? <span /> : <div className="flex flex-wrap items-center gap-3">{step > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setStep(step - 1)}><ArrowLeft aria-hidden className="mr-1 h-3 w-3" />{c.back}</Button>}<p className="text-xs text-[var(--workspace-text-muted)]">{c.selected} {hostIds.length} · {selectedPermissions.length ? `${c.capabilities} ${selectedPermissions.length}` : c.cacheOnly}</p></div>}
        {generated ? <Button size="sm" onClick={discardConfiguration}>{c.done}</Button>
          : step < 2 ? <Button size="sm" disabled={disabled || !validScope || (step === 1 && !validPermissions)} onClick={() => setStep(step + 1)}>{step === 0 ? c.next : c.review}<ChevronRight aria-hidden className="ml-1 h-3 w-3" /></Button>
          : <Button data-tour="mcp-create" size="sm" disabled={disabled || !validScope || !validPermissions} onClick={() => void create()}>{t('mcp.create')}</Button>}
      </div>
    </div>
  )

  const clientsCard = status && (
    <div data-tour="mcp-clients" className="sb-card min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <h4 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('mcp.clients')} <span className="ml-1 text-xs font-normal text-[var(--workspace-text-muted)]">{fill(v.clientCount, { count: status.clients.length })}</span></h4>
        <Button size="sm" variant="outline" onClick={() => { setChosenTab('manual'); stepHeading.current?.scrollIntoView?.({ block: 'center' }); stepHeading.current?.focus() }}><Plus aria-hidden className="mr-1 h-3.5 w-3.5" />{v.connectNew}</Button>
      </div>
      {!status.clients.length && <p className="px-4 py-4 text-xs text-[var(--workspace-text-muted)]">{t('mcp.noClients')}</p>}
      <div className="divide-y divide-[color:var(--workspace-border-soft)]">{status.clients.map(client => <div key={client.id} className="px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2.5">{client.agentId ? <AIProviderLogo brand={client.agentId as AIBrandId} className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-text-strong)]" /> : <Bot aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />}<div className="min-w-0"><p className="break-words text-sm font-medium text-[var(--workspace-text-strong)]">{client.name}</p><p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{client.hosts.length} {c.hosts} · {status.audit.some(entry => entry.clientId === client.id && entry.outcome === 'accepted') ? c.observed : c.waiting}</p></div></div><div className="flex gap-2">{revokeId === client.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevokeId(null)}>{c.cancel}</Button>}<Button size="sm" variant="ghost" className={cn(revokeId === client.id && 'bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]')} disabled={busy} onClick={() => { if (revokeId !== client.id) { setRevokeId(client.id); return } void action(async () => { await revokeMcpClient(client.id); setRevokeId(null); if (generated?.clientId === client.id) discardConfiguration() }) }}>{t(revokeId === client.id ? 'mcp.confirmRevoke' : 'mcp.revoke')}</Button></div></div>
        {revokeId === client.id && <p className="mt-2 text-xs text-[var(--workspace-status-warn-text)]">{c.revokeHint}</p>}
        <details className="ml-6 mt-2 text-xs text-[var(--workspace-text-muted)]"><summary className="cursor-pointer">{c.clientDetails}</summary>
          <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-[var(--workspace-text-subtle)]">{v.vault}</dt><dd className="break-all text-[var(--workspace-text)]">{t('mcp.clientScope', { count: client.hosts.length, vault: client.vaultId })}</dd>
            <dt className="text-[var(--workspace-text-subtle)]">{v.permissions}</dt><dd className="text-[var(--workspace-text)]">{Object.entries(client.permissions).filter(([, enabled]) => enabled).map(([key]) => c.permission[key as keyof McpPermissions]?.[0] ?? key).join(' / ') || c.noExtra}</dd>
            <dt className="text-[var(--workspace-text-subtle)]">{v.hostsAccounts}</dt><dd><ul className="space-y-0.5 text-[var(--workspace-text)]">{client.hosts.map(grant => <li key={grant.id} className="break-all">{client.vaultId === activeVaultId ? hosts.find(host => host.id === grant.id)?.name ?? grant.id : grant.id}{grant.connections && ` · ${grant.connections.length} ${c.accounts}`}</li>)}</ul></dd>
          </dl>
        </details>
      </div>)}</div>
      <div className="border-t border-[color:var(--workspace-border-soft)] px-4 py-2.5">{note(v.revokeNote)}</div>
    </div>
  )

  const auditCard = status && (
    <div className="sb-card min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <h4 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{c.auditTitle}</h4>
        {status.activeOperations > 0 && <span className="rounded bg-[var(--workspace-surface-800)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-text)]">{fill(v.activeChip, { count: status.activeOperations })}</span>}
      </div>
      <p className="px-4 pt-2.5 text-xs text-[var(--workspace-text-muted)]">{t('mcp.activeOperations', { count: status.activeOperations })}</p>
      {status.audit.length > 0 ? <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] text-[var(--workspace-text-subtle)]"><tr className="border-b border-[color:var(--workspace-border-soft)]"><th className="px-4 py-2 font-normal">{v.auditTime}</th><th className="px-2 py-2 font-normal">{v.auditClient}</th><th className="px-2 py-2 font-normal">{v.auditTool}</th><th className="px-4 py-2 font-normal">{v.auditResult}</th></tr></thead>
          <tbody className="divide-y divide-[color:var(--workspace-border-soft)]">{status.audit.map((entry, index) => <tr key={`${entry.at}-${index}`}>
            <td className="whitespace-nowrap px-4 py-2 font-mono text-[var(--workspace-text)]" title={new Date(entry.at).toLocaleString()}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
            <td className="break-words px-2 py-2 text-[var(--workspace-text)]">{status.clients.find(client => client.id === entry.clientId)?.name ?? entry.clientId}</td>
            <td className="break-all px-2 py-2 font-mono text-[var(--workspace-text)]">{entry.tool}</td>
            <td className="px-4 py-2"><span className={cn('inline-flex items-center gap-1.5', entry.outcome === 'accepted' ? 'text-[var(--workspace-status-good-text)]' : entry.outcome === 'rejected' || entry.outcome === 'denied' ? 'text-[var(--workspace-status-bad-text)]' : 'text-[var(--workspace-status-warn-text)]')}><span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', entry.outcome === 'accepted' ? 'bg-[var(--workspace-status-good)]' : entry.outcome === 'rejected' || entry.outcome === 'denied' ? 'bg-[var(--workspace-status-bad)]' : 'bg-[var(--workspace-status-warn)]')} />{v.outcome[entry.outcome] ?? entry.outcome}</span></td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{v.noAudit}</p>}
      <details className="border-t border-[color:var(--workspace-border-soft)] px-4 py-2.5"><summary className="flex cursor-pointer items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><List aria-hidden className="h-3.5 w-3.5" />{v.fullRecords}</summary><OperationsAuditCenter source="mcp" vaultId={activeVaultId} limit={100} className="mt-3 border-t border-[color:var(--workspace-border-soft)] pt-3" /></details>
    </div>
  )

  const okQuickResults = quickResults?.filter(res => res.ok) ?? []
  const failedQuickResults = quickResults?.filter(res => !res.ok) ?? []
  const presetToneWarn = quickPreset === 'full' || (!loadingHosts && (quickHosts.length === 0 || (quickNeedsSsh && !quickHasSshHost)))
  const presetSummaryText = !loadingHosts && quickHosts.length === 0
    ? c.quickNoHosts
    : !loadingHosts && quickNeedsSsh && !quickHasSshHost
      ? c.quickSshRequired
      : `${c.quickPresets[quickPreset][1]}${!loadingHosts ? ` · ${fill(c.quickScope, { count: quickHosts.length })}` : ''}`

  return <section className="min-w-0 space-y-4" data-testid="mcp-settings" data-tour="mcp-settings" data-tour-ready={Boolean(status || error)}>
    <div className="sb-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-[1_1_16rem]">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('mcp.title')}</h3>
          {status && (
            <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', status.running ? 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', status.running ? 'bg-[var(--workspace-status-good)]' : 'bg-[var(--workspace-text-subtle)]')} />
              {status.running ? c.running : c.stopped}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{v.mcpDesc}</p>
      </div>
      <label data-tour="mcp-toggle" className="relative inline-flex shrink-0 cursor-pointer items-center">
        <input type="checkbox" aria-label={t('mcp.enabled')} className="peer sr-only" checked={status?.enabled ?? false} disabled={disabled || !status?.desktopSupported} onChange={event => { void action(() => setMcpEnabled(event.target.checked)) }} />
        <span aria-hidden className="h-5 w-9 rounded-full bg-[var(--workspace-surface-700)] transition-colors peer-checked:bg-[color:var(--workspace-primary-500)] peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50" />
        <span aria-hidden className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
      </label>
    </div>

    {status && !status.desktopSupported && <p className="text-sm text-[var(--workspace-text-muted)]">{t('mcp.desktopOnly')}</p>}
    {error && <p role="alert" className="break-words text-xs text-[var(--workspace-status-bad-text)]">{error}</p>}

    {status?.desktopSupported && (hasLocalAgents ? (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={t('mcp.title')} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1">
            {([
              ['agents', c.tabAgents, installedAgents.length > 0 ? `${connectedAgentCount}/${installedAgents.length}` : undefined],
              ['manual', c.tabManual, undefined],
              ['clients', c.tabClients, status.clients.length > 0 ? String(status.clients.length) : undefined],
              ['audit', c.tabAudit, status.activeOperations > 0 ? String(status.activeOperations) : undefined],
            ] as Array<[McpViewTab, string, string | undefined]>).map(([id, label, badge]) => (
              <button
                key={id}
                type="button"
                role="tab"
                data-testid={`mcp-subtab-${id}`}
                aria-selected={activeTab === id}
                onClick={() => setChosenTab(id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors',
                  activeTab === id
                    ? 'bg-[var(--workspace-surface-800)] font-semibold text-[var(--workspace-text-strong)] shadow-sm'
                    : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                <span>{label}</span>
                {badge && (
                  <span className="rounded bg-[var(--workspace-surface-900)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]">
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'agents' && (
          <div className="sb-card min-w-0 overflow-hidden" data-testid="mcp-quick-agents">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
              <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-0.5" role="group" aria-label={c.quickPresetLabel}>
                {(['cache', 'readOnly', 'full'] as const).map(preset => {
                  const active = quickPreset === preset
                  const risky = preset === 'full'
                  return (
                    <button
                      key={preset}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() => setQuickPreset(preset)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                        active
                          ? risky
                            ? 'bg-[var(--workspace-status-warn-bg)] font-semibold text-[var(--workspace-status-warn-text)]'
                            : 'bg-[var(--workspace-surface-800)] font-semibold text-[var(--workspace-text-strong)]'
                          : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                      )}
                    >
                      {c.quickPresets[preset][0]}
                    </button>
                  )
                })}
              </div>

              <div className="flex items-center gap-1.5">
                <Button size="sm" disabled={!quickCanConnectAll} onClick={() => void quickConnect(installedAgentIds)}>
                  <Sparkles aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                  {busy ? c.quickConnecting : fill(c.quickOpenAll, { count: installedAgentIds.length })}
                </Button>
                <Button size="sm" variant="ghost" aria-label={c.quickRefresh} title={c.quickRefresh} disabled={disabled || scanningAgents} onClick={() => void refreshDetectedAgents()} className="px-2">
                  <RefreshCw aria-hidden className={cn('h-3.5 w-3.5', scanningAgents && 'animate-spin')} />
                </Button>
              </div>
            </div>

            <div className={cn(
              'flex items-start gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2 text-xs',
              presetToneWarn ? 'bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]' : 'bg-[var(--workspace-surface-950)]/50 text-[var(--workspace-text-muted)]',
            )}>
              {presetToneWarn ? <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />}
              <span className="leading-relaxed">{presetSummaryText}</span>
            </div>

            {quickResults && quickResults.length > 0 && (
              <div role="status" className="border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-4 py-2.5 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    {okQuickResults.length > 0 && (
                      <p className="font-medium text-[var(--workspace-status-good-text)]">
                        ✓ {fill(c.quickSuccessSummary, { count: okQuickResults.length })}
                      </p>
                    )}
                    {failedQuickResults.map(res => (
                      <p key={res.agentId} className="text-[var(--workspace-status-bad-text)]">
                        ✕ {res.name}: {res.error}
                      </p>
                    ))}
                    {okQuickResults.length > 0 && (
                      <ul className="space-y-0.5 pt-0.5 font-mono text-[11px] text-[var(--workspace-text-muted)]">
                        {okQuickResults.map(res => (
                          <li key={res.agentId} className="truncate" title={res.configPath ?? undefined}>
                            {res.name} · {res.configPath}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <button type="button" aria-label={c.cancel} onClick={() => setQuickResults(null)} className="shrink-0 text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text-strong)]">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {installedAgents.length > 0 ? (
              <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                {installedAgents.map(renderAgentRow)}
              </div>
            ) : (
              <p className="px-4 py-5 text-xs text-[var(--workspace-text-muted)]">{c.quickNoDetected}</p>
            )}

            {uninstalledAgents.length > 0 && (
              <details className="border-t border-[color:var(--workspace-border-soft)]">
                <summary className="cursor-pointer select-none px-4 py-2.5 text-xs text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]">
                  {fill(c.quickUninstalledSummary, { count: uninstalledAgents.length })}
                  <span className="ml-1.5 text-[var(--workspace-text-subtle)]">
                    ({uninstalledAgents.map(a => a.name).join(' · ')})
                  </span>
                </summary>
                <div className="divide-y divide-[color:var(--workspace-border-soft)] border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]/40">
                  {uninstalledAgents.map(renderAgentRow)}
                </div>
              </details>
            )}

            <div className="border-t border-[color:var(--workspace-border-soft)] px-4 py-2">
              <p className="text-[11px] text-[var(--workspace-text-subtle)]">{c.quickRevokeCleanup}</p>
            </div>
          </div>
        )}

        {activeTab === 'manual' && (
          <div className="space-y-3">
            {manualWizardCard}
            {!status.enabled && note(c.offline)}
          </div>
        )}

        {activeTab === 'clients' && clientsCard}
        {activeTab === 'audit' && auditCard}
      </>
    ) : (
      <>
        {manualWizardCard}
        {!status.enabled && note(c.offline)}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {clientsCard}
          {auditCard}
        </div>
      </>
    ))}
  </section>
}
