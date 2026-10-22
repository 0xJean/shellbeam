import { NativeSelect } from '@/components/ui/select'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { buildDiagnosticLogCommand, type DiagnosticLogSource } from '@/lib/workspace-diagnostics'
import { WorkspaceEmptyState } from './workspace-empty-state'

const LOG_SOURCES = [
  { id: 'journal', labelKey: 'workspace.logs.source.journal' },
  { id: 'syslog', labelKey: 'workspace.logs.source.syslog' },
  { id: 'file', labelKey: 'workspace.diagnostics.fileLogs' },
] as const
interface WorkspaceLogsAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  vaultId?: string
  initialUnit?: string
}

export function WorkspaceLogsApp({ selectedHostId = null, hostAddress = null, hosts, resolveAuthSecret, vaultId, initialUnit }: WorkspaceLogsAppProps) {
  const { t } = useT()
  const [source, setSource] = useState<DiagnosticLogSource>('journal')
  const [unit, setUnit] = useState(initialUnit ?? '')
  const [priority, setPriority] = useState('')
  const [since, setSince] = useState('1h')
  const [filePath, setFilePath] = useState('/var/log/syslog')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [output, setOutput] = useState('')
  const [outputScope, setOutputScope] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [followKey, setFollowKey] = useState<string | null>(null)
  const requests = useRef(0)
  const follow = useRef<{ active: boolean; deadline: number; timer?: ReturnType<typeof setTimeout> }>({ active: false, deadline: 0 })
  const host = useMemo(() => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }), [hosts, selectedHostId, hostAddress])
  const scope = `${vaultId ?? ''}:${host?.id ?? ''}:${source}`
  const following = followKey === scope
  const query = { source, unit: unit.trim(), priority, since, filePath }
  let commandPreview = ''
  try { commandPreview = buildDiagnosticLogCommand(query) } catch { /* Invalid inputs are reported when submitted. */ }
  const scopedOutput = outputScope === scope ? output : ''
  const visibleOutput = search ? scopedOutput.split('\n').filter((line) => line.toLowerCase().includes(search.toLowerCase())).join('\n') : scopedOutput

  async function loadLogs() {
    if (!host) return
    const request = ++requests.current
    setLoading(true)
    setError('')
    setCopied(false)
    try {
      const command = buildDiagnosticLogCommand(query)
      const result = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command, audit: { action: 'logs.read', target: source === 'journal' && query.unit ? `journal:${query.unit}` : `${source} log snapshot (path omitted)` } })
      if (request !== requests.current) return
      if (result.exitCode !== 0) throw new Error(result.stderr || 'log_read_failed')
      // Enforce a second local bound in case the remote utility ignores its limit.
      setOutput(result.stdout.slice(-256 * 1024).split('\n').slice(-201).join('\n') || t('workspace.logs.noOutput'))
      setOutputScope(scope)
    } catch (caught) {
      if (request === requests.current) { setError(caught instanceof Error ? caught.message : String(caught)); setOutput('') }
    } finally { if (request === requests.current) setLoading(false) }
  }
  function stopFollowing() {
    follow.current.active = false
    clearTimeout(follow.current.timer)
    requests.current++
    setLoading(false)
    setFollowKey(null)
  }
  function startFollowing() {
    follow.current.active = true
    follow.current.deadline = Date.now() + 5 * 60_000
    setFollowKey(scope)
    async function tick() {
      if (!follow.current.active) return
      if (Date.now() >= follow.current.deadline) { stopFollowing(); return }
      await loadLogs()
      if (follow.current.active) follow.current.timer = setTimeout(() => { void tick() }, 3000)
    }
    void tick()
  }
  async function copyLogs() {
    try { await navigator.clipboard.writeText(visibleOutput); setCopied(true) }
    catch { setError(t('workspace.diagnostics.copyFailed')) }
  }
  useEffect(() => {
    const activeRequests = requests
    const activeFollow = follow.current
    void loadLogs()
    return () => { activeRequests.current++; activeFollow.active = false; clearTimeout(activeFollow.timer); setFollowKey(null) }
    // Filters are explicitly applied with Refresh; changing source/host cancels the old reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, vaultId, source])

  if (!host) return <WorkspaceEmptyState title={t('workspace.app.logs')} description={t('workspace.logs.emptyDescription')} />
  return <div data-testid="workspace-logs-app" className="space-y-4">
    <div className="rounded-xl border border-border/60 bg-card px-6 py-5"><h2 className="text-2xl font-semibold">{t('workspace.logs.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('workspace.diagnostics.logsBounded')}</p></div>
    <div className="flex flex-wrap gap-3">{LOG_SOURCES.map((item) => <button key={item.id} type="button" disabled={following} onClick={() => setSource(item.id)} className={`rounded-xl border px-4 py-3 text-sm ${source === item.id ? 'border-primary bg-primary/10' : 'border-border'}`}>{t(item.labelKey)}</button>)}</div>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
      {source === 'journal' ? <>
        <input aria-label={t('workspace.diagnostics.logUnit')} placeholder={t('workspace.diagnostics.logUnit')} value={unit} disabled={following} onChange={(event) => setUnit(event.target.value)} className="rounded border bg-background p-2 text-sm" />
        <NativeSelect aria-label={t('workspace.diagnostics.logPriority')} value={priority} disabled={following} onChange={(event) => setPriority(event.target.value)} className="rounded border bg-background p-2 text-sm"><option value="">{t('workspace.diagnostics.allPriorities')}</option>{['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].map((value) => <option key={value}>{value}</option>)}</NativeSelect>
        <NativeSelect aria-label={t('workspace.diagnostics.logSince')} value={since} disabled={following} onChange={(event) => setSince(event.target.value)} className="rounded border bg-background p-2 text-sm">{['5m', '1h', '24h', '7d'].map((value) => <option key={value}>{value}</option>)}</NativeSelect>
      </> : source === 'file' ? <input aria-label={t('workspace.diagnostics.logPath')} value={filePath} disabled={following} onChange={(event) => setFilePath(event.target.value)} className="min-w-64 rounded border bg-background p-2 text-sm" /> : null}
      <input aria-label={t('workspace.diagnostics.searchLogs')} placeholder={t('workspace.diagnostics.searchLogs')} value={search} onChange={(event) => setSearch(event.target.value)} className="rounded border bg-background p-2 text-sm" />
      <button type="button" disabled={loading || following} onClick={() => void loadLogs()}>{t('workspace.diagnostics.refreshLogs')}</button>
      <button type="button" onClick={following ? stopFollowing : startFollowing}>{t(following ? 'workspace.diagnostics.stopFollowing' : 'workspace.diagnostics.follow')}</button>
      <button type="button" disabled={!visibleOutput} onClick={() => void copyLogs()}>{t(copied ? 'workspace.diagnostics.copied' : 'workspace.diagnostics.copyLogs')}</button>
    </div>
    <code className="block break-all text-xs text-muted-foreground">{commandPreview}</code>
    {following && <p role="status" className="text-xs text-muted-foreground">{t('workspace.diagnostics.followBounded')}</p>}
    {error ? <div role="alert" className="rounded border border-red-500/20 p-4 text-sm text-red-400">{error}</div> : <pre data-testid="workspace-logs-output" className="max-h-[26rem] overflow-auto whitespace-pre-wrap rounded-xl border bg-card p-4 text-xs leading-6">{loading && !output ? t('workspace.logs.loadingLogs') : visibleOutput}</pre>}
  </div>
}
