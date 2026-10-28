import { getHostIdentity } from '@/lib/host-identity'
import { remoteOperationStatus } from '@/lib/operation-verification'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { buildDockerCommand, DOCKER_LIST_COMMAND, parseDockerContainers, runDockerContainerAction, type DockerContainer } from '@/lib/docker-ops'
import { fill } from '@/lib/locales/probe-install'
import { workspaceOpsPanelsCopy } from '@/lib/locales/workspace-ops-panels'
import { cn } from '@/lib/utils'
import { CircleAlert, Play, RefreshCw, RotateCcw, ScrollText, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface DockerOpsPanelProps {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function statusClass(running: boolean) {
  return running ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]'
}

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)(\s?)(.*)$/
const LOG_LEVEL = /\b(error|fatal|panic|warn(?:ing)?)\b/i

function highlightLine(line: string, index: number) {
  if (/^verification=verified\b/.test(line)) return <span key={index} className="text-[color:var(--workspace-status-good-text)]">{line}</span>
  if (/^verification=unknown\b/.test(line)) return <span key={index} className="text-[color:var(--workspace-status-warn-text)]">{line}</span>
  const stamped = LOG_TIMESTAMP.exec(line)
  const body = stamped ? stamped[3] : line
  const level = LOG_LEVEL.exec(body)
  const rest = level
    ? <>{body.slice(0, level.index)}<span className={/^(error|fatal|panic)$/i.test(level[1]) ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[color:var(--workspace-status-warn-text)]'}>{level[1]}</span>{body.slice(level.index + level[1].length)}</>
    : body
  return <span key={index}>{stamped && <span className="text-[var(--workspace-text-subtle)]">{stamped[1]}{stamped[2]}</span>}{rest}</span>
}

function highlightOutput(output: string) {
  return output.split('\n').flatMap((line, index) => index === 0 ? [highlightLine(line, index)] : ['\n', highlightLine(line, index)])
}

export function DockerOpsPanel({ host, resolveAuthSecret }: DockerOpsPanelProps) {
  const { t, locale } = useT()
  const c = workspaceOpsPanelsCopy[locale].docker
  const [rows, setRows] = useState<DockerContainer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [outputSource, setOutputSource] = useState<{ name: string; logs: boolean } | null>(null)
  const [action, setAction] = useState<'start' | 'stop' | 'restart' | 'logs' | null>(null)
  const scope = JSON.stringify([host.vaultId, getHostIdentity(host)])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const loadGeneration = useRef(0)
  const loadErrorMessage = t('workspace.docker.observationUnavailable')
  const selected = useMemo(() => rows.find((row) => row.name === selectedName) ?? rows[0] ?? null, [rows, selectedName])

  const loadContainers = useCallback(async () => {
    const generation = ++loadGeneration.current
    const isCurrent = () => generation === loadGeneration.current && scope === currentScope.current
    setLoading(true)
    setError('')
    setUnsupported(false)
    try {
      const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: DOCKER_LIST_COMMAND, audit: { action: 'docker.list', target: 'docker containers' } })
      if (!isCurrent()) return
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (/__SB_DOCKER_UNAVAILABLE|command not found/i.test(combined) || result.exitCode === 127) {
        setUnsupported(true)
        setRows([])
        return
      }
      if (remoteOperationStatus(result) !== 'completed') {
        setRows([])
        setError(loadErrorMessage)
        return
      }
      const parsed = parseDockerContainers(combined)
      setRows(parsed)
      setSelectedName((current) => current && parsed.some((row) => row.name === current) ? current : parsed[0]?.name ?? null)
      if (parsed.length === 0 && combined) setOutput(combined)
    } catch (caught) {
      if (!isCurrent()) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setRows([])
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [host, resolveAuthSecret, scope, loadErrorMessage])

  async function execute(actionName: 'start' | 'stop' | 'restart' | 'logs', container: DockerContainer) {
    const actionScope = scope
    setSelectedName(container.name)
    setAction(actionName)
    setError('')
    try {
      if (actionName === 'logs') {
        const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: buildDockerCommand('logs', container.id), audit: { action: 'docker.logs', target: container.name } })
        if (actionScope !== currentScope.current) return
        if (remoteOperationStatus(result) !== 'completed') setError(t('workspace.docker.observationUnavailable'))
        setOutputSource({ name: container.name, logs: true })
        setOutput([result.stdout, result.stderr].filter(Boolean).join('\n') || (remoteOperationStatus(result) === 'completed' ? t('workspace.docker.actionCompleted') : t('workspace.docker.observationUnavailable')))
        return
      }
      const execution = await runDockerContainerAction({
        host,
        resolveAuthSecret,
        action: actionName,
        container,
        confirmMessage: t('workspace.docker.confirm', { action: t(`workspace.docker.action.${actionName}`), target: container.name }),
      })
      if (actionScope !== currentScope.current) return
      setOutputSource({ name: container.name, logs: false })
      if (!execution) {
        setOutput(t('workspace.operation.cancelled'))
        return
      }
      const result = execution.value
      setOutput(`job=${execution.job.jobId} audit=${execution.job.auditId} status=${execution.job.status}\nverification=${result.verification.status}; ${result.verification.summary}\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`)
      const observedContainer = result.container
      if (observedContainer) setRows((current) => current.map((row) => row.id === observedContainer.id ? observedContainer : row))
    } catch (caught) {
      if (actionScope === currentScope.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (actionScope === currentScope.current) setAction(null)
    }
  }

  useEffect(() => {
    const generations = loadGeneration
    setRows([]); setSelectedName(null); setOutput(''); setOutputSource(null); setAction(null)
    void loadContainers()
    return () => { generations.current++ }
  }, [loadContainers])

  const quietButton = 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-40'
  const outputTitle = outputSource ? fill(outputSource.logs ? c.logsTitle : c.outputTitle, { name: outputSource.name }) : null

  return (
    <section data-testid="docker-ops-panel" className="flex min-h-0 flex-col gap-4 p-4 text-[var(--workspace-text)] md:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h2>
          <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{fill(c.summary, { count: rows.length })}</p>
        </div>
        <button type="button" onClick={() => void loadContainers()} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60">
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />{loading ? t('workspace.docker.loading') : t('workspace.docker.reload')}
        </button>
      </header>
      {unsupported ? <div className="sb-card px-4 py-6 text-center text-xs text-[var(--workspace-text-muted)]">{t('workspace.docker.unsupported')}</div> : error ? <div role="alert" className="rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{error}</div> : (
        <div className="sb-card overflow-hidden">
          {loading && rows.length === 0 ? <div className="px-4 py-6 text-xs text-[var(--workspace-text-muted)]">{t('workspace.docker.loadingContainers')}</div> : rows.length === 0 ? <div className="px-4 py-6 text-xs text-[var(--workspace-text-muted)]">{t('workspace.docker.empty')}</div> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-[color:var(--workspace-border-soft)] text-left text-xs font-medium text-[var(--workspace-text-subtle)]">
                    <th className="px-4 py-2.5 font-medium">{c.container}</th>
                    <th className="px-3 py-2.5 font-medium">{c.image}</th>
                    <th className="px-3 py-2.5 font-medium">{c.status}</th>
                    <th className="px-3 py-2.5 font-medium">{c.ports}</th>
                    <th className="px-3 py-2.5 font-medium"><span className="sr-only">{c.actions}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isSelected = selected?.name === row.name
                    return (
                      <tr key={row.id} data-selected={isSelected || undefined} onClick={() => setSelectedName(row.name)} className={cn('cursor-pointer border-b border-[color:var(--workspace-border-soft)] last:border-b-0', isSelected ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[var(--workspace-surface-800)]')}>
                        <td className="max-w-[200px] truncate px-4 py-3 font-semibold text-[var(--workspace-text-strong)]">{row.name}</td>
                        <td className="max-w-[260px] truncate px-3 py-3 font-mono text-xs text-[var(--workspace-text-muted)]" title={row.image}>{row.image}</td>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', statusClass(row.running))}>{row.running ? t('workspace.docker.status.running') : t('workspace.docker.status.stopped')}</span>
                            <span className="text-xs text-[var(--workspace-text-muted)]">{row.status}</span>
                          </span>
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-3 font-mono text-xs text-[var(--workspace-text-muted)]" title={row.ports || undefined}>{row.ports ? row.ports.replace(/->/g, '→') : '—'}</td>
                        <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                          <div className="flex items-center justify-end gap-0.5">
                            <button type="button" className={quietButton} onClick={() => void execute('start', row)} disabled={action !== null || row.running}><Play className="h-3.5 w-3.5" />{t('workspace.docker.action.start')}</button>
                            <button type="button" className={quietButton} onClick={() => void execute('stop', row)} disabled={action !== null || !row.running}><Square className="h-3.5 w-3.5" />{t('workspace.docker.action.stop')}</button>
                            <button type="button" className={quietButton} onClick={() => void execute('restart', row)} disabled={action !== null}><RotateCcw className="h-3.5 w-3.5" />{t('workspace.docker.action.restart')}</button>
                            <button type="button" className={quietButton} onClick={() => void execute('logs', row)} disabled={action !== null}><ScrollText className="h-3.5 w-3.5" />{t('workspace.docker.action.logs')}</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {output && (
        <div className="sb-card flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
            <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{outputTitle ?? c.title}</h3>
            {outputSource?.logs && <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{c.readOnly}</span>}
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap bg-[var(--workspace-surface-950)] px-4 py-3 font-mono text-[11px] leading-5 text-[var(--workspace-text)]" data-testid="docker-ops-output">{highlightOutput(output)}</pre>
        </div>
      )}
      {!unsupported && !error && rows.length > 0 && <p className="flex items-center gap-1.5 text-[11px] text-[var(--workspace-text-subtle)]"><CircleAlert className="h-3 w-3" />{t('workspace.docker.auditNote')}</p>}
    </section>
  )
}

export default DockerOpsPanel
