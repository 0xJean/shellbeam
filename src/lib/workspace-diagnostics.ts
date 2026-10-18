import type { CommandRunResult } from './sessions'
import { isRemoteOperationOutcomeUnknown, remoteOperationStatus } from './operation-verification'

export const PROCESS_LIMIT = 5000
export const PROCESS_PAGE_SIZE = 50
export const PROCESS_COMMAND = `LC_ALL=C ps -eo pid=,%cpu=,%mem=,state=,comm= --sort=pid | head -n ${PROCESS_LIMIT + 1}`
export interface DiagnosticProcess { pid: string; command: string; cpu: string; memory: string; state: string }
export function safeDiagnosticPid(pid: string) { return /^[1-9][0-9]{0,8}$/.test(pid) }
export function safeDiagnosticService(name: string) { return /^[A-Za-z0-9_][A-Za-z0-9_.@:-]*\.service$/.test(name) && name.length <= 160 }
export function parseDiagnosticProcesses(output: string): DiagnosticProcess[] {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\S+)\s+(.+)$/)
    return match && safeDiagnosticPid(match[1]) ? [{ pid: match[1], cpu: match[2], memory: match[3], state: match[4], command: match[5].slice(0, 256) }] : []
  }).slice(0, PROCESS_LIMIT + 1)
}
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }
export type DiagnosticLogSource = 'journal' | 'syslog' | 'file'
export interface DiagnosticLogQuery { source: DiagnosticLogSource; unit: string; priority: string; since: string; filePath: string }
export function buildDiagnosticLogCommand(query: DiagnosticLogQuery) {
  if (query.source === 'syslog') return 'tail -n 200 -- /var/log/syslog 2>/dev/null || tail -n 200 -- /var/log/messages'
  if (query.source === 'file') {
    if (!query.filePath.startsWith('/') || query.filePath.length > 4096 || Array.from(query.filePath).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('invalid_log_path')
    return `tail -n 200 -- ${quote(query.filePath)}`
  }
  if (query.unit && !safeDiagnosticService(query.unit)) throw new Error('invalid_log_unit')
  if (!['', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].includes(query.priority)) throw new Error('invalid_log_priority')
  const since: Record<string, string> = { '5m': '5 minutes ago', '1h': '1 hour ago', '24h': '24 hours ago', '7d': '7 days ago' }
  if (!since[query.since]) throw new Error('invalid_log_since')
  return ['journalctl -n 200 --no-pager --output=short-iso', `--since=${quote(since[query.since])}`, query.unit ? `--unit=${quote(query.unit)}` : '', query.priority ? `--priority=${query.priority}` : ''].filter(Boolean).join(' ')
}
export type DiagnosticServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type VerifiedDiagnosticResult = CommandRunResult & { resultSummary: string; errorCode?: string; errorSummary?: string }
type RunCommand = (command: string) => Promise<CommandRunResult>
function unverifiable(result: CommandRunResult, check: CommandRunResult, summary: string): VerifiedDiagnosticResult {
  return { ...result, durationMs: result.durationMs + check.durationMs, exitCode: check.exitCode || 125, errorCode: isRemoteOperationOutcomeUnknown(check) ? check.errorCode ?? 'remote_state_unknown' : 'remote_state_unknown', errorType: 'unknown', resultSummary: `${summary}; verification=unknown`, errorSummary: 'The action was sent but its resulting state could not be observed; inspect the host before retrying' }
}
export async function executeVerifiedServiceAction(run: RunCommand, service: string, action: DiagnosticServiceAction): Promise<VerifiedDiagnosticResult> {
  if (!safeDiagnosticService(service)) throw new Error('invalid_service_name')
  const result = await run(`systemctl ${action} -- ${service}`)
  if (remoteOperationStatus(result) !== 'completed') return { ...result, resultSummary: `action=${action}; verification=not-run; exit=${result.exitCode}` }
  const check = await run(`systemctl show --property=ActiveState --property=UnitFileState -- ${service}`)
  const active = check.stdout.match(/^ActiveState=([a-z-]+)$/m)?.[1]
  const enabled = check.stdout.match(/^UnitFileState=([a-z-]+)$/m)?.[1]
  if (remoteOperationStatus(check) !== 'completed' || ((action === 'enable' || action === 'disable') ? !enabled : !active)) return unverifiable(result, check, `action=${action}`)
  const passed = check.exitCode === 0 && (action === 'stop' ? active === 'inactive' : action === 'enable' ? enabled === 'enabled' || enabled === 'enabled-runtime' : action === 'disable' ? enabled === 'disabled' : active === 'active')
  return {
    ...result, stdout: check.stdout, stderr: check.stderr, durationMs: result.durationMs + check.durationMs,
    exitCode: passed ? 0 : 125,
    resultSummary: `action=${action}; verification=${passed ? 'passed' : 'failed'}; active=${active ?? 'unknown'}; enabled=${enabled ?? 'unknown'}`,
    ...(passed ? {} : { errorCode: 'post_state_unverified', errorSummary: 'The service did not reach the requested state; inspect fresh status before retrying' }),
  }
}
export async function executeVerifiedProcessTermination(run: RunCommand, pid: string): Promise<VerifiedDiagnosticResult> {
  if (!safeDiagnosticPid(pid)) throw new Error('invalid_process_id')
  const result = await run(`kill -TERM -- ${pid}`)
  if (remoteOperationStatus(result) !== 'completed') return { ...result, resultSummary: `signal=TERM; verification=not-run; exit=${result.exitCode}` }
  let durationMs = result.durationMs
  for (let attempt = 0; attempt < 3; attempt++) {
    const check = await run(`ps -p ${pid} -o pid=,state=`)
    durationMs += check.durationMs
    if (check.exitCode === 1 && !check.stdout.trim() && !check.stderr.trim() && !isRemoteOperationOutcomeUnknown(check) && (!check.errorType || check.errorType === 'command') && (!check.errorCode || check.errorCode === 'remote_command_failed')) return { ...result, durationMs, resultSummary: 'signal=TERM; verification=passed; process=absent' }
    if (remoteOperationStatus(check) !== 'completed' || !new RegExp(`^\\s*${pid}\\s+[A-Za-z]`, 'm').test(check.stdout)) return unverifiable({ ...result, durationMs: durationMs - check.durationMs }, check, 'signal=TERM')
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { ...result, durationMs, exitCode: 125, resultSummary: 'signal=TERM; verification=failed; process=present-or-unverified', errorCode: 'post_state_unverified', errorSummary: 'Process termination was not verified; inspect current state before retrying' }
}
