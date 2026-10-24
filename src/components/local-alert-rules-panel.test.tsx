import { fireEvent, render, screen, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from '@/lib/hosts'
import { I18nProvider } from '@/lib/i18n'
import { LocalAlertRulesPanel } from './local-alert-rules-panel'
import { clearLocalOpsMemory, loadLocalAlertRules, loadLocalAlertState, saveLocalAlertState } from '@/lib/local-ops-store'
import { EMPTY_LOCAL_ALERT_STATE, evaluateLocalAlertRules } from '@/lib/local-alert-rules'
import { collectLocalAlertObservations } from '@/lib/local-alert-collector'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host: HostProfile = { id: 'host', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', group: 'Custom', tags: [], createdAt: 1, updatedAt: 1 }
beforeEach(() => {
  localStorage.clear(); clearLocalOpsMemory(); localStorage.setItem('shellbeam.locale', 'en')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let job: Record<string, unknown> = {}
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    const request = (args as { request: Record<string, unknown> }).request
    if (command === 'operation_job_create') { job = { ...request, jobId: 'canonical-job', auditId: 'audit', status: 'queued', confirmationStatus: 'pending' }; return { ...job } }
    if (command === 'operation_job_update') { job = { ...job, ...request }; return { ...job } }
    throw new Error('unexpected command')
  })
})
describe('LocalAlertRulesPanel', () => {
  it('exposes only this Vault evaluation sampling time and never freshens an unknown observation', () => {
    render(<I18nProvider><LocalAlertRulesPanel activeVaultId="vault" hostId={host.id} host={host} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'service' } })
    fireEvent.change(screen.getByLabelText('Service unit'), { target: { value: 'nginx.service' } })
    fireEvent.change(screen.getByLabelText('Trigger duration (seconds)'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Recovery duration (seconds)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add alert rule' }))
    const rules = loadLocalAlertRules('vault', host.id)
    const row = screen.getByTestId('local-rule-row')
    expect(row).toHaveAttribute('data-rule-state', 'unknown')
    expect(row).not.toHaveAttribute('data-sampled-at')
    const observe = (value: number | null, sampledAt: number) => [{ ruleId: rules[0].id, value, sampledAt, source: 'ssh-agentless', transport: 'direct' as const }]
    act(() => saveLocalAlertState('foreign-vault', host.id, evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, rules, observe(1, 9_000), 9_000)))
    expect(row).not.toHaveAttribute('data-sampled-at')
    let state = evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, rules, observe(1, 1_000), 1_000)
    act(() => saveLocalAlertState('vault', host.id, state))
    expect(row).toHaveAttribute('data-rule-state', 'firing')
    expect(row).toHaveAttribute('data-sampled-at', '1000')
    state = evaluateLocalAlertRules(state, rules, observe(null, 1_500), 1_500)
    act(() => saveLocalAlertState('vault', host.id, state))
    expect(row).toHaveAttribute('data-rule-state', 'unknown')
    expect(row).toHaveAttribute('data-sampled-at', '1000')
    state = evaluateLocalAlertRules(state, rules, observe(0, 2_000), 2_000)
    act(() => saveLocalAlertState('vault', host.id, state))
    expect(row).toHaveAttribute('data-rule-state', 'healthy')
    expect(row).toHaveAttribute('data-sampled-at', '2000')
    expect(screen.getByTestId('local-alert-row')).toHaveAttribute('data-alert-status', 'resolved')
  })

  it('configures sustained thresholds and exposes acknowledged/closed audit state', async () => {
    render(<I18nProvider><LocalAlertRulesPanel activeVaultId="vault" hostId="host" host={host} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'CPU hot' } })
    fireEvent.change(screen.getByLabelText('Trigger at (%)'), { target: { value: '85' } })
    fireEvent.change(screen.getByLabelText('Recover below (%)'), { target: { value: '70' } })
    fireEvent.change(screen.getByLabelText('Trigger duration (seconds)'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add alert rule' }))
    const rule = loadLocalAlertRules('vault', 'host')[0]
    expect(rule).toMatchObject({ name: 'CPU hot', threshold: 85, recoveryThreshold: 70, durationMs: 10_000 })
    const observe = (at: number) => [{ ruleId: rule.id, value: 99, sampledAt: at, source: 'ssh-agentless', transport: 'direct' as const }]
    let state = evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, [rule], observe(1_000), 1_000)
    state = evaluateLocalAlertRules(state, [rule], observe(11_000), 11_000)
    act(() => { saveLocalAlertState('vault', 'host', state) })
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(loadLocalAlertState('vault', 'host').alerts[0].status).toBe('acknowledged'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close alert' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Close alert' }))
    await waitFor(() => expect(loadLocalAlertState('vault', 'host').alerts[0].status).toBe('closed'))
    expect(loadLocalAlertState('vault', 'host').audit.at(-1)?.operationJobId).toBe('canonical-job')
    expect(screen.getByText('Alert audit (3)')).toBeInTheDocument()
  })
  it('rejects unsafe service units instead of issuing commands', () => {
    render(<I18nProvider><LocalAlertRulesPanel activeVaultId="vault" hostId="host" host={host} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'service' } })
    fireEvent.change(screen.getByLabelText('Service unit'), { target: { value: 'nginx; rm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add alert rule' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid rule')
    expect(loadLocalAlertRules('vault', 'host')).toEqual([])
  })
  it('shows the observed ProxyJump route for service alerts on a saved jump reference', async () => {
    const profile = { ...host, jumpHostId: 'saved-bastion' }
    render(<I18nProvider><LocalAlertRulesPanel activeVaultId="vault" hostId="host" host={profile} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'service' } })
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Nginx failed' } })
    fireEvent.change(screen.getByLabelText('Service unit'), { target: { value: 'nginx.service' } })
    fireEvent.change(screen.getByLabelText('Trigger duration (seconds)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add alert rule' }))
    const rules = loadLocalAlertRules('vault', host.id)
    const observations = await collectLocalAlertObservations({ vaultId: 'vault', host: profile, rules, resolveAuthSecret: vi.fn(), now: 1_000,
      runCommand: vi.fn().mockResolvedValue({ stdout: '__SB_RULE_SERVICE_0=failed\n', exitCode: 0 }) })
    act(() => saveLocalAlertState('vault', host.id, evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, rules, observations, 1_000)))
    expect(screen.getByTestId('local-alert-row')).toHaveAttribute('data-transport', 'proxy-jump')
    expect(screen.getByTestId('local-alert-row')).toHaveTextContent('Nginx failed · Active · ssh-agentless · proxy-jump')
  })
})
