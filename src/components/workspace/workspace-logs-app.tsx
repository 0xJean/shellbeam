import { NativeSelect } from '@/components/ui/select'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Copy, Radio, RotateCw, Search, Square, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceNetLogsCopy } from '@/lib/locales/workspace-netlogs'
import { cn } from '@/lib/utils'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { buildDiagnosticLogCommand, type DiagnosticLogSource } from '@/lib/workspace-diagnostics'
import { WorkspaceEmptyState } from './workspace-empty-state'

const LOG_SOURCES = [
  { id: 'journal', labelKey: 'workspace.logs.source.journal' },
  { id: 'syslog', labelKey: 'workspace.logs.source.syslog' },
  { id: 'file', labelKey: 'workspace.diagnostics.fileLogs' },
] as const
const FOLLOW_WINDOW_MS = 5 * 60_000
const FOLLOW_INTERVAL_MS = 3000
const LINE_PREFIX = /^([A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \S+ )/
const ERROR_LINE = /\b(emerg|crit|critical|err|error|fatal|panic)\b/i
const WARN_LINE = /\b(warn|warning)\b/i
const segmentedGroup = 'inline-flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-0.5'
const segmentedButton = (active: boolean) => cn('rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', active ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')
const field = 'flex h-8 items-center gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] px-2.5 text-[var(--workspace-text-subtle)] focus-within:ring-1 focus-within:ring-primary'
const fieldInput = 'min-w-0 flex-1 bg-transparent text-[13px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] disabled:opacity-60'

function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function highlight(text: string, search: string) {
  if (!search) return text
  const needle = search.toLowerCase()
  const parts: Array<string | { match: string }> = []
  let cursor = 0
  for (let index = text.toLowerCase().indexOf(needle); index !== -1; index = text.toLowerCase().indexOf(needle, cursor)) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push({ match: text.slice(index, index + needle.length) })
    cursor = index + needle.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, index) => typeof part === 'string' ? <Fragment key={index}>{part}</Fragment> : <mark key={index} className="rounded-sm bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-text-strong)] ring-1 ring-[color:var(--workspace-status-warn-border)]">{part.match}</mark>)
}

interface WorkspaceLogsAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  vaultId?: string
  initialUnit?: string
}

export function WorkspaceLogsApp({ selectedHostId = null, hostAddress = null, hosts, resolveAuthSecret, vaultId, initialUnit }: WorkspaceLogsAppProps) {
  const { t, locale } = useT()
  const c = workspaceNetLogsCopy[locale]
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
  const [clock, setClock] = useState<{ now: number; deadline: number; next: number | null }>({ now: 0, deadline: 0, next: null })
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
  const totalLines = scopedOutput.split('\n').filter((line) => line.trim()).length
  const visibleLines = visibleOutput ? visibleOutput.split('\n') : []
  const matchedLines = visibleLines.filter((line) => line.trim()).length

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
      setOutput(result.stdout.slice(-256 * 1024).split('\n').slice(-201).join('\n'))
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
    const now = Date.now()
    follow.current.active = true
    follow.current.deadline = now + FOLLOW_WINDOW_MS
    setClock({ now, deadline: follow.current.deadline, next: null })
    setFollowKey(scope)
    async function tick() {
      if (!follow.current.active) return
      if (Date.now() >= follow.current.deadline) { stopFollowing(); return }
      setClock((current) => ({ ...current, next: null }))
      await loadLogs()
      if (!follow.current.active) return
      follow.current.timer = setTimeout(() => { void tick() }, FOLLOW_INTERVAL_MS)
      const settled = Date.now()
      setClock((current) => ({ ...current, now: settled, next: settled + FOLLOW_INTERVAL_MS }))
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
  useEffect(() => {
    if (!following) return
    const timer = setInterval(() => setClock((current) => ({ ...current, now: Date.now() })), 1000)
    return () => clearInterval(timer)
  }, [following])

  if (!host) return <WorkspaceEmptyState title={t('workspace.app.logs')} description={t('workspace.logs.emptyDescription')} />
  const remaining = formatRemaining(clock.deadline - clock.now)
  const nextRefresh = clock.next === null ? null : Math.max(0, Math.ceil((clock.next - clock.now) / 1000))
  const placeholder = loading && !scopedOutput ? t('workspace.logs.loadingLogs') : outputScope !== scope ? '' : scopedOutput.trim() ? c.noMatches : t('workspace.logs.noOutput')
  return <div data-testid="workspace-logs-app" className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-[var(--workspace-text-strong)]">{t('workspace.app.logs')}</h2><p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{c.logsSubtitle}</p></div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {following ? <>
          <span role="status" title={t('workspace.diagnostics.followBounded')} className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-[var(--workspace-status-good-bg)] px-2.5 text-xs font-medium text-[color:var(--workspace-status-good-text)]">
            <i aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-[var(--workspace-status-good)]" />
            {nextRefresh === null ? fill(c.followingRefreshing, { remaining }) : fill(c.following, { remaining, next: nextRefresh })}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={stopFollowing}><Square className="mr-1 h-3.5 w-3.5" />{t('workspace.diagnostics.stopFollowing')}</Button>
        </> : <>
          <Button type="button" size="sm" variant="outline" onClick={startFollowing}><Radio className="mr-1 h-3.5 w-3.5" />{t('workspace.diagnostics.follow')}</Button>
          <Button type="button" size="sm" disabled={loading} onClick={() => void loadLogs()}><RotateCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} />{t('workspace.diagnostics.refreshLogs')}</Button>
        </>}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2.5">
      <div role="group" aria-label={t('workspace.logs.title')} className={segmentedGroup}>{LOG_SOURCES.map((item) => <button key={item.id} type="button" aria-pressed={source === item.id} disabled={following} onClick={() => setSource(item.id)} className={segmentedButton(source === item.id)}>{t(item.labelKey)}</button>)}</div>
      {source === 'journal' ? <>
        <label className={cn(field, 'w-56')}><Box aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><input aria-label={t('workspace.diagnostics.logUnit')} placeholder={t('workspace.diagnostics.logUnit')} value={unit} disabled={following} onChange={(event) => setUnit(event.target.value)} className={fieldInput} /></label>
        <NativeSelect aria-label={t('workspace.diagnostics.logPriority')} value={priority} disabled={following} onChange={(event) => setPriority(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-[13px]"><option value="">{t('workspace.diagnostics.allPriorities')}</option>{['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].map((value) => <option key={value}>{value}</option>)}</NativeSelect>
        <div role="group" aria-label={t('workspace.diagnostics.logSince')} className={segmentedGroup}>{['5m', '1h', '24h', '7d'].map((value) => <button key={value} type="button" aria-pressed={since === value} disabled={following} onClick={() => setSince(value)} className={segmentedButton(since === value)}>{value}</button>)}</div>
      </> : source === 'file' ? <label className={cn(field, 'min-w-64 flex-1')}><input aria-label={t('workspace.diagnostics.logPath')} value={filePath} disabled={following} onChange={(event) => setFilePath(event.target.value)} className={cn(fieldInput, 'font-mono')} /></label> : null}
    </div>
    <div className="flex flex-wrap items-center gap-2.5">
      <label className={cn(field, 'min-w-60 flex-1')}>
        <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <input aria-label={t('workspace.diagnostics.searchLogs')} placeholder={t('workspace.diagnostics.searchLogs')} value={search} onChange={(event) => setSearch(event.target.value)} className={fieldInput} />
        {scopedOutput && <span data-testid="workspace-logs-match-count" className="shrink-0 font-mono text-[11px] text-[var(--workspace-text-subtle)]">{search ? fill(c.matched, { matched: matchedLines, total: totalLines }) : fill(c.lines, { total: totalLines })}</span>}
      </label>
      <Button type="button" size="sm" variant="outline" disabled={!visibleOutput} onClick={() => void copyLogs()}><Copy className="mr-1 h-3.5 w-3.5" />{t(copied ? 'workspace.diagnostics.copied' : 'workspace.diagnostics.copyLogs')}</Button>
      <span className="text-[11.5px] text-[var(--workspace-text-subtle)]">{c.filterNote}</span>
    </div>
    {commandPreview && <div className="flex items-start gap-2 rounded-md bg-[var(--workspace-surface-800)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--workspace-text-muted)]"><SquareTerminal aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" /><code className="min-w-0 break-all">{commandPreview}</code></div>}
    {error ? <div role="alert" className="rounded-xl border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] p-4 text-sm text-[color:var(--workspace-status-bad-text)]">{error}</div>
      : <pre data-testid="workspace-logs-output" className="sb-card max-h-[26rem] overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-5 text-[var(--workspace-text)]">
        {visibleOutput ? visibleLines.map((line, index) => {
          const prefix = LINE_PREFIX.exec(line)?.[1] ?? ''
          const body = line.slice(prefix.length)
          return <span key={index} className={cn('block min-h-5', ERROR_LINE.test(body) ? 'text-[color:var(--workspace-status-bad-text)]' : WARN_LINE.test(body) && 'text-[color:var(--workspace-status-warn-text)]')}>
            {prefix && <span className="text-[var(--workspace-text-subtle)]">{highlight(prefix, search)}</span>}{highlight(body, search)}
          </span>
        }) : <span className="text-[var(--workspace-text-muted)]">{placeholder}</span>}
      </pre>}
  </div>
}
