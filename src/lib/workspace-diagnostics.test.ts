import { describe, expect, it, vi } from 'vitest'
import { buildDiagnosticLogCommand, executeVerifiedProcessTermination, executeVerifiedServiceAction, parseDiagnosticProcesses, safeDiagnosticService } from './workspace-diagnostics'
const result = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, durationMs: 5 })
const journal = { source: 'journal' as const, unit: '', priority: '', since: '1h', filePath: '/var/log/syslog' }

describe('bounded host diagnostics', () => {
  it('preserves process names with spaces while rejecting headers and invalid rows', () => {
    expect(parseDiagnosticProcesses(' 12 10.1 0.5 S app worker\nPID CPU MEM\ninvalid')).toEqual([{ pid: '12', cpu: '10.1', memory: '0.5', state: 'S', command: 'app worker' }])
  })
  it('allows fixed journal filters and rejects command injection in units, priorities and time ranges', () => {
    expect(buildDiagnosticLogCommand({ ...journal, unit: 'nginx.service', priority: 'err', since: '5m' })).toContain("--unit='nginx.service' --priority=err")
    for (const query of [{ ...journal, unit: 'nginx.service;id' }, { ...journal, priority: 'err;id' }, { ...journal, since: '$(id)' }]) expect(() => buildDiagnosticLogCommand(query)).toThrow()
    expect(safeDiagnosticService('-evil.service')).toBe(false)
  })
  it('shell-quotes custom file paths and rejects control characters and relative paths', () => {
    expect(buildDiagnosticLogCommand({ ...journal, source: 'file', filePath: "/var/log/a'$(id).log" })).toBe("tail -n 200 -- '/var/log/a'\\''$(id).log'")
    expect(() => buildDiagnosticLogCommand({ ...journal, source: 'file', filePath: 'relative.log' })).toThrow()
    expect(() => buildDiagnosticLogCommand({ ...journal, source: 'file', filePath: '/var/log/a\nwhoami' })).toThrow()
  })
  it('verifies stop as inactive without invoking systemctl status or treating status exit 3 as failure', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result('ActiveState=inactive\nUnitFileState=enabled'))
    const verified = await executeVerifiedServiceAction(run, 'nginx.service', 'stop')
    expect(verified).toMatchObject({ exitCode: 0, resultSummary: 'action=stop; verification=passed; active=inactive; enabled=enabled' })
    expect(run.mock.calls.map(([command]) => command)).toEqual(['systemctl stop -- nginx.service', 'systemctl show --property=ActiveState --property=UnitFileState -- nginx.service'])
  })
  it('fails verification when a requested service state is not proven and checks boot state independently', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result('ActiveState=failed\nUnitFileState=enabled'))
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'stop')).toMatchObject({ exitCode: 125, errorCode: 'post_state_unverified' })
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result('ActiveState=inactive\nUnitFileState=enabled'))
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'enable')).toMatchObject({ exitCode: 0 })
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result('ActiveState=active\nUnitFileState=disabled'))
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'disable')).toMatchObject({ exitCode: 0 })
  })
  it('verifies process absence after TERM and rejects unsafe PID input without executing', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result('', 1))
    expect(await executeVerifiedProcessTermination(run, '412')).toMatchObject({ exitCode: 0, resultSummary: 'signal=TERM; verification=passed; process=absent' })
    await expect(executeVerifiedProcessTermination(run, '412;id')).rejects.toThrow('invalid_process_id')
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('propagates post-action disconnect for OperationJob unknown-state classification', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('connection lost'))
    await expect(executeVerifiedServiceAction(run, 'nginx.service', 'restart')).rejects.toThrow('connection lost')
  })
  it('keeps unobservable post-state unknown rather than claiming mutation failure or successful absence', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result('', 124), errorCode: 'target_timeout' })
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'stop')).toMatchObject({ errorCode: 'target_timeout', resultSummary: 'action=stop; verification=unknown' })
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result('', 1), stderr: 'permission denied /private/path password=hidden' })
    const termination = await executeVerifiedProcessTermination(run, '412')
    expect(termination).toMatchObject({ errorCode: 'remote_state_unknown', resultSummary: 'signal=TERM; verification=unknown' })
    expect(termination.resultSummary).not.toContain('hidden')
    expect(termination.errorSummary).not.toContain('/private/path')
  })
  it('never treats exit-zero plus unknown post-state metadata as observed service success', async () => {
    const run = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result('ActiveState=active\nUnitFileState=enabled'), errorType: 'unknown', errorCode: 'remote_state_unknown' })
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'restart')).toMatchObject({ exitCode: 125, errorCode: 'remote_state_unknown', errorType: 'unknown', resultSummary: 'action=restart; verification=unknown' })
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('does not issue postchecks when native command acceptance is unknown and recognizes ordinary ps absence metadata', async () => {
    const run = vi.fn().mockResolvedValueOnce({ ...result(), errorType: 'unknown', errorCode: 'remote_state_unknown' })
    expect(await executeVerifiedServiceAction(run, 'nginx.service', 'restart')).toMatchObject({ errorCode: 'remote_state_unknown', resultSummary: 'action=restart; verification=not-run; exit=0' })
    expect(run).toHaveBeenCalledTimes(1)
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result('', 1), errorType: 'command', errorCode: 'remote_command_failed' })
    expect(await executeVerifiedProcessTermination(run, '412')).toMatchObject({ exitCode: 0, resultSummary: 'signal=TERM; verification=passed; process=absent' })
  })
})
