import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostGridCard, HostListItem, type HostOperationalSummary } from './host-card'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { OperationAuditEntry } from '@/lib/operation-job'
import type { KomariAlertAuditEntry, KomariAlertRecord } from '@/lib/komari-alerts'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import type { HostOpsProbeEvaluation } from '@/lib/host-ops-view'
import { I18nProvider } from '@/lib/i18n'

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '203.0.113.8',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password' as const,
  tags: ['web', 'critical'],
  createdAt: 0,
  updatedAt: 0,
}

const sampledMetrics: ServerMonitorSnapshot = {
  hostname: 'api', os: 'Linux', kernel: '', uptimeSeconds: 90_061, cpuPercent: 15, load1: null, load5: null, load15: null,
  memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null,
  networkRxBytesPerSec: 1024, networkTxBytesPerSec: 2048, latencyMs: null, sampledAt: 1000,
}
const oldResource = { hostname: 'api', os: 'Linux', kernel: '', uptime: 'old uptime', cpuPercent: 95, memoryPercent: 20, memoryText: '', diskPercent: 30, diskText: '', network: 'old throughput' }

function openOperations() {
  const toggle = screen.getByTestId('host-ops-details-toggle')
  expect(toggle).toBeVisible()
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('host-ops-details')).toBeVisible()
}

describe('host list item', () => {
  it.each((['grid', 'list'] as const).flatMap(mode => (['en', 'zh-CN'] as const).flatMap(locale =>
    (['offline', 'stale'] as const).map(status => ({ mode, locale, status })),
  )))('labels Komari $status as monitoring data in the $locale $mode view without blocking SSH', ({ mode, locale, status }) => {
    const previousLocale = localStorage.getItem('shellbeam.locale')
    localStorage.setItem('shellbeam.locale', locale)
    try {
      const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', provider: 'komari' }
      const onConnect = vi.fn()
      const props = { host, status, operations, monitoring: false, isSelected: false, onConnect, onSelect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
      render(<I18nProvider>{mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />}</I18nProvider>)
      const expected = locale === 'zh-CN'
        ? status === 'offline' ? '监控中断' : '监控数据过期'
        : status === 'offline' ? 'Monitoring interrupted' : 'Monitoring data stale'
      expect(screen.getByText(expected)).toBeVisible()
      expect(screen.queryByText(locale === 'zh-CN' ? '离线' : 'Offline', { exact: true })).not.toBeInTheDocument()
      expect(screen.getByTestId('host-card')).toHaveAttribute('data-host-health', status)
      expect(screen.getByTestId('host-connect')).toBeEnabled()
      fireEvent.click(screen.getByTestId('host-connect'))
      expect(onConnect).toHaveBeenCalledExactlyOnceWith(host.id)
    } finally {
      if (previousLocale === null) localStorage.removeItem('shellbeam.locale')
      else localStorage.setItem('shellbeam.locale', previousLocale)
    }
  })

  it('keeps grid diagnostics and audit details collapsed while exposing the alert count and actions on demand', () => {
    const onLocalAlertAction = vi.fn()
    const operations: HostOperationalSummary = {
      vaultId: 'vault-a', serviceTotal: 4, serviceActive: 3, serviceFailed: 1, processTotal: 2, processRunning: 2,
      auditCount: 1, provider: 'ssh-agentless', transport: 'direct', localAlertOpen: 1,
      localAlerts: [{ ruleId: 'cpu-hot', hostId: host.id, name: 'CPU pressure', metric: 'cpu', severity: 'critical', status: 'active', openedAt: 1, updatedAt: 2, resolvedAt: null, value: 99, source: 'ssh-agentless', transport: 'direct' }],
      latestAudit: { auditId: 'audit-visible-on-demand', action: 'service.restart', target: 'nginx', status: 'completed', createdAt: 2, transport: 'direct', provider: 'ssh-agentless', source: 'workspace' },
      onLocalAlertAction,
    }
    const onConnect = vi.fn(), onSelect = vi.fn()
    render(<HostGridCard host={host} operations={operations} isSelected={false} onConnect={onConnect} onSelect={onSelect} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('host-ops-summary')).toBeVisible()
    expect(screen.getByTestId('host-ops-local-alerts')).toHaveAttribute('data-open-count', '1')
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
    expect(screen.getByTestId('host-local-alert')).not.toBeVisible()
    expect(screen.getByText(/audit-visible-on-demand/)).not.toBeVisible()
    openOperations()
    expect(screen.getByTestId('host-local-alert')).toBeVisible()
    expect(screen.getByText(/audit-visible-on-demand/)).toBeVisible()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-cpu-hot'))
    expect(onLocalAlertAction).toHaveBeenCalledExactlyOnceWith(operations.localAlerts![0], 'acknowledge')
    expect(onConnect).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('keeps connection and alert handling available without resource placeholders in %s connection mode', (mode) => {
    const onConnect = vi.fn(), onSelect = vi.fn(), onLocalAlertAction = vi.fn()
    const operations: HostOperationalSummary = {
      serviceTotal: 4, serviceActive: 3, serviceFailed: 1, processTotal: 2, processRunning: 2, auditCount: 0, transport: 'direct', provider: 'ssh-agentless', localAlertOpen: 1,
      localAlerts: [{ ruleId: 'cpu-hot', hostId: host.id, name: 'CPU pressure', metric: 'cpu', severity: 'warning', status: 'active', openedAt: 1, updatedAt: 2, resolvedAt: null, value: 99, source: 'ssh-agentless', transport: 'direct' }], onLocalAlertAction,
    }
    const props = { host, monitoring: false, metrics: sampledMetrics, resource: oldResource, operations, isSelected: false, onConnect, onSelect, onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-resource-throughput')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-resource-uptime')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-ops-compact-source')).not.toBeInTheDocument()
    expect(screen.getByTestId('host-ops-local-alerts')).toBeVisible()
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
    openOperations()
    fireEvent.click(screen.getByTestId('local-host-alert-ack-cpu-hot'))
    expect(onLocalAlertAction).toHaveBeenCalledExactlyOnceWith(operations.localAlerts![0], 'acknowledge')
    fireEvent.click(screen.getByTestId('host-connect'))
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(host.id)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('isolates %s batch selection from host selection and terminal opening', (mode) => {
    const onConnect = vi.fn(), onSelect = vi.fn(), onChange = vi.fn()
    const props = { host, monitoring: false, batchSelection: { selected: false, disabled: false, onChange }, isSelected: false, onConnect, onSelect, onEdit: vi.fn(), onDelete: vi.fn() }
    const view = render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    const checkbox = screen.getByRole('checkbox', { name: /Production API/ })
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledOnce()
    fireEvent.doubleClick(checkbox)
    fireEvent.keyDown(checkbox, { key: 'Enter' })
    fireEvent.keyDown(checkbox, { key: ' ' })
    expect(onConnect).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    const disabled = { ...props, batchSelection: { ...props.batchSelection, disabled: true } }
    view.rerender(mode === 'grid' ? <HostGridCard {...disabled} /> : <HostListItem {...disabled} index={1} />)
    expect(screen.getByRole('checkbox', { name: /Production API/ })).toBeDisabled()
  })

  it('keeps the host main row separate from hidden full-width operational details', () => {
    const sampledAt = Date.now() - 1_000
    const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: 4, serviceActive: 3, serviceFailed: 1, processTotal: 2, processRunning: 2, auditCount: 1, provider: 'ssh-agentless', transport: 'proxy-jump', sampledAt, localAlertOpen: 1, highestAlertSeverity: 'critical', localAlerts: [{ ruleId: 'probe-error', hostId: host.id, name: 'Long collection diagnosis '.repeat(10), metric: 'probe-provider', severity: 'critical', status: 'active', openedAt: sampledAt, updatedAt: sampledAt, resolvedAt: null, value: 1, source: 'ssh-agentless', transport: 'proxy-jump' }] }
    render(<HostListItem index={1} host={{ ...host, vaultId: 'vault-a' }} isSelected operations={operations} onOpenWorkspace={vi.fn()} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const primary = screen.getByTestId('host-list-primary')
    const details = screen.getByTestId('host-ops-details')
    const compact = screen.getByTestId('host-ops-summary')
    expect(primary).toBeVisible()
    expect(primary.parentElement).toBe(details.parentElement)
    expect(primary).toContainElement(compact)
    expect(primary).not.toContainElement(details)
    expect(primary).not.toContainElement(screen.getByTestId('host-local-alert'))
    expect(details).toHaveAttribute('hidden')
    expect(details).not.toBeVisible()
    expect(screen.getAllByTestId('host-ops-summary')).toHaveLength(1)
    expect(compact).toHaveAttribute('data-vault-id', 'vault-a')
    expect(compact).toHaveAttribute('data-host-id', host.id)
    expect(compact).toHaveAttribute('data-sampled-at', String(sampledAt))
    expect(compact).toHaveTextContent('3/4')
    expect(compact).toHaveTextContent('2/2')
    expect(within(compact).getByTestId('host-ops-compact-source')).toHaveTextContent('SSH')
    const alertSummary = within(primary).getByTestId('host-ops-local-alerts')
    expect(alertSummary).toBeVisible()
    expect(alertSummary).toHaveAttribute('data-open-count', '1')
    expect(alertSummary).toHaveAttribute('data-severity', 'critical')
    expect(within(primary).getByRole('button', { name: 'Services · Production API' })).toBeVisible()
    expect(within(primary).getByRole('combobox', { name: 'Open operations for Production API' })).toBeVisible()
    openOperations()
    expect(screen.getByTestId('host-local-alert')).toBeVisible()
    expect(primary).not.toContainElement(screen.getByTestId('host-ops-details-summary'))
  })

  it.each<{ label: string; state: Partial<HostOperationalSummary>; expected: string }>([
    { label: 'remote active count with no local incident journal', state: { alertActive: 1, localAlertOpen: 0 }, expected: '1' },
    { label: 'remote active count with an empty local incident journal', state: { alertActive: 1, komariAlerts: [], localAlertOpen: 0 }, expected: '1' },
    { label: 'explicitly zero open incidents ahead of the remote aggregate', state: { alertOpen: 0, alertActive: 3, komariAlerts: [], localAlertOpen: 0 }, expected: '0' },
    { label: 'unsupported remote counts without known local alerts', state: { alertUnsupported: true, alertActive: 3, komariAlerts: [], localAlertOpen: 0 }, expected: '—' },
    { label: 'unknown alert observations', state: {}, expected: '—' },
    { label: 'known local alerts despite unsupported remote counts', state: { alertUnsupported: true, alertActive: 3, komariAlerts: [], localAlertOpen: 2 }, expected: '2' },
    { label: 'known local alerts with unknown remote counts', state: { localAlertOpen: 2 }, expected: '2' },
  ])('shows $label in the collapsed main row', ({ state, expected }) => {
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', ...state }
    render(<HostListItem index={1} host={host} operations={operations} isSelected={false} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const summary = within(screen.getByTestId('host-list-primary')).getByTestId('host-ops-alert-summary')
    expect(summary).toBeVisible()
    expect(within(summary).getByText(expected, { selector: 'strong' })).toBeVisible()
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
    expect(screen.getByTestId('host-ops-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    if (state.alertOpen === 0) expect(summary).toHaveAttribute('data-open', '0')
    if ((state.localAlertOpen ?? 0) > 0) {
      expect(within(summary).getByTestId('host-ops-local-alerts')).toHaveAttribute('data-open-count', String(state.localAlertOpen))
    }
  })

  it('expands and collapses details without selecting, connecting, or bubbling keyboard events', () => {
    const onSelect = vi.fn(), onConnect = vi.fn(), parent = vi.fn()
    const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: 1, serviceActive: 1, serviceFailed: 0, processTotal: 1, processRunning: 1, auditCount: 0, transport: 'direct' }
    render(<div onClick={parent} onDoubleClick={parent} onKeyDown={parent}><HostListItem index={1} host={host} operations={operations} isSelected={false} onSelect={onSelect} onConnect={onConnect} onEdit={vi.fn()} onDelete={vi.fn()} /></div>)
    const toggle = screen.getByTestId('host-ops-details-toggle')
    const details = screen.getByTestId('host-ops-details')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', details.id)
    expect(details.id).not.toBe('')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(details).toBeVisible()
    fireEvent.doubleClick(toggle)
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.keyDown(toggle, { key: ' ' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(details).not.toBeVisible()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
    expect(parent).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('collapses %s details when the same host id changes Vault, and keeps a new host collapsed', (mode) => {
    const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: 1, serviceActive: 1, serviceFailed: 0, processTotal: 1, processRunning: 1, auditCount: 0, transport: 'direct' }
    const props = { index: 1, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const card = (vaultId: string, id = host.id) => mode === 'grid' ? <HostGridCard {...props} host={{ ...host, id, vaultId }} operations={{ ...operations, vaultId }} /> : <HostListItem {...props} host={{ ...host, id, vaultId }} operations={{ ...operations, vaultId }} />
    const view = render(card('vault-a'))
    openOperations()
    view.rerender(card('vault-b'))
    expect(screen.getByTestId('host-ops-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
    expect(screen.getByTestId('host-ops-summary')).toHaveAttribute('data-vault-id', 'vault-b')
    view.rerender(card('vault-a'))
    expect(screen.getByTestId('host-ops-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
    view.rerender(card('vault-b'))
    openOperations()
    view.rerender(card('vault-b', 'another-host'))
    expect(screen.getByTestId('host-ops-details-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('host-ops-details')).not.toBeVisible()
  })

  it('does not render an empty disclosure when the host has no operations', () => {
    render(<HostListItem index={1} host={host} isSelected={false} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByTestId('host-ops-details-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-ops-details')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-ops-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('host-list-primary')).toBeVisible()
  })

  it.each(['grid', 'list'] as const)('visibly shows healthy Probe sections without an alert, then retains the real sample after resolution in %s', (mode) => {
    const sampledAt = Date.now() - 60_000
    const evaluation: HostOpsProbeEvaluation = { ruleId: `probe:ssh-agentless:${'a'.repeat(32)}:metrics`, section: 'metrics', state: 'healthy', sampledAt }
    const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'proxy-jump', localAlerts: [], localAlertEvaluations: [evaluation, { ...evaluation, ruleId: evaluation.ruleId.replace('metrics', 'inventory'), section: 'inventory' }], sampledAt: Date.now() }
    const props = { host, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const card = (summary: HostOperationalSummary) => mode === 'grid' ? <HostGridCard {...props} operations={summary} /> : <HostListItem {...props} index={1} operations={summary} />
    const view = render(card(operations))
    openOperations()
    const [metrics, inventory] = screen.getAllByTestId('host-probe-evaluation')
    expect(metrics).toBeVisible()
    expect(metrics).toHaveTextContent('Metrics')
    expect(metrics).toHaveTextContent('Healthy')
    expect(metrics).toHaveTextContent('1m ago')
    expect(inventory).toHaveTextContent('Inventory')
    expect(metrics).toHaveAttribute('data-state', 'healthy')
    expect(metrics).toHaveAttribute('data-rule-id', evaluation.ruleId)
    expect(metrics).toHaveAttribute('data-vault-id', 'vault-a')
    expect(metrics).toHaveAttribute('data-host-id', host.id)
    expect(metrics).toHaveAttribute('data-sampled-at', String(sampledAt))
    expect(metrics).toHaveAttribute('title', new Date(sampledAt).toISOString())
    expect(screen.queryByTestId('host-local-alert')).not.toBeInTheDocument()
    const resolvedAt = Date.now() - 1_000
    const alert: LocalAlertRecord = { ruleId: evaluation.ruleId, hostId: host.id, name: 'Probe recovered', metric: 'probe-provider', status: 'resolved', severity: 'warning', openedAt: sampledAt - 10_000, updatedAt: resolvedAt, resolvedAt, value: 0, source: 'ssh-agentless', transport: 'proxy-jump', operationJobId: 'ack-job' }
    view.rerender(card({ ...operations, localAlerts: [alert] }))
    const row = screen.getByTestId('host-local-alert')
    expect(row).toHaveTextContent('Recovered')
    expect(row).toHaveAttribute('data-metric', 'probe-provider')
    expect(row).toHaveAttribute('data-job-id', 'ack-job')
    expect(row).toHaveAttribute('data-vault-id', 'vault-a')
    expect(row).toHaveAttribute('data-updated-at', String(resolvedAt))
    expect(row).toHaveAttribute('data-resolved-at', String(resolvedAt))
    expect(screen.getAllByTestId('host-probe-evaluation')[0]).toHaveAttribute('data-sampled-at', String(sampledAt))
  })

  it.each(['grid', 'list'] as const)('shows expired and missing Probe evidence as unknown, with no made-up sample, in %s', (mode) => {
    const oldSample = Date.now() - 180_001
    const evaluation: HostOpsProbeEvaluation = { ruleId: `probe:ssh-agentless:${'a'.repeat(32)}:metrics`, section: 'metrics', state: 'healthy', sampledAt: oldSample }
    const operations: HostOperationalSummary = { vaultId: 'vault-a', serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', localAlertEvaluations: [evaluation, { ...evaluation, ruleId: evaluation.ruleId.replace('metrics', 'inventory'), section: 'inventory', sampledAt: null }] }
    const props = { host: { ...host, vaultId: 'vault-a' }, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const card = (summary: HostOperationalSummary) => mode === 'grid' ? <HostGridCard {...props} operations={summary} /> : <HostListItem {...props} index={1} operations={summary} />
    const view = render(card(operations))
    openOperations()
    const [old, missing] = screen.getAllByTestId('host-probe-evaluation')
    expect(old).toHaveAttribute('data-state', 'unknown')
    expect(old).toHaveTextContent('Unknown')
    expect(old).toHaveAttribute('data-sampled-at', String(oldSample))
    expect(old).toHaveAttribute('title', new Date(oldSample).toISOString())
    expect(missing).toHaveTextContent('Unknown')
    expect(missing).toHaveTextContent('No sample')
    expect(missing).not.toHaveAttribute('data-sampled-at')
    expect(missing).not.toHaveAttribute('title')
    expect(screen.getByTestId('host-ops-summary')).not.toHaveAttribute('data-sampled-at')
    view.rerender(card({ ...operations, vaultId: 'vault-b' }))
    expect(screen.queryByTestId('host-probe-evaluation')).not.toBeInTheDocument()
    view.rerender(card({ ...operations, vaultId: undefined }))
    expect(screen.queryByTestId('host-probe-evaluation')).not.toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('keeps lifecycle diagnostic failures visible without any persisted alert rows in %s', (mode) => {
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', localAlerts: [], localAlertPersistenceError: true, probeAlertLifecycleError: true }
    const props = { host, operations, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    {
      expect(screen.getByTestId('host-ops-attention')).toBeVisible()
      expect(screen.getByTestId('host-ops-attention')).toHaveTextContent('Review needed')
      expect(screen.getByText('Native operations history could not be saved or changed in another session. Refresh before continuing.')).not.toBeVisible()
    }
    openOperations()
    expect(screen.getByText('Native operations history could not be saved or changed in another session. Refresh before continuing.')).toBeVisible()
    expect(screen.getByText('Probe alert recording is unavailable. The next collection will retry.')).toBeVisible()
    expect(screen.queryByTestId('host-local-alert')).not.toBeInTheDocument()
  })
  it.each(['grid', 'list'] as const)('shows independent local/Probe lifecycle, source, route and job actions in %s', (mode) => {
    const alert: LocalAlertRecord = { ruleId: 'probe-collection', hostId: host.id, name: 'Probe collection failed', metric: 'probe-provider', status: 'active', severity: 'warning', openedAt: 1000, updatedAt: 2000, resolvedAt: null, value: 1, source: 'shellbeam-agent', transport: 'proxy-jump', operationJobId: 'probe-job' }
    const onLocalAlertAction = vi.fn()
    const onKomariAlertAction = vi.fn()
    const parent = vi.fn()
    const props = { host: { ...host, jumpHostId: 'saved-bastion' }, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), operations: { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'proxy-jump' as const, localAlerts: [alert], onLocalAlertAction, onKomariAlertAction } }
    render(<div onClick={parent} onDoubleClick={parent} onKeyDown={parent}>{mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />}</div>)
    openOperations()
    const row = screen.getByTestId('host-local-alert')
    expect(row).toBeVisible()
    expect(row).toHaveTextContent('ProbeProvider collection')
    expect(row).toHaveTextContent('shellbeam-agent')
    expect(row).toHaveTextContent('ProxyJump')
    expect(row).toHaveTextContent('job=probe-job')
    expect(row).toHaveAttribute('data-transport', 'proxy-jump')
    const acknowledge = screen.getByTestId('local-host-alert-ack-probe-collection')
    fireEvent.click(acknowledge)
    expect(onLocalAlertAction).toHaveBeenLastCalledWith(alert, 'acknowledge')
    fireEvent.doubleClick(acknowledge)
    fireEvent.keyDown(acknowledge, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('local-host-alert-close-probe-collection'))
    expect(onLocalAlertAction).toHaveBeenLastCalledWith(alert, 'close')
    expect(onKomariAlertAction).not.toHaveBeenCalled()
    expect(parent).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('limits %s local controls to legal statuses, handler and idle state', (mode) => {
    const base: LocalAlertRecord = { ruleId: 'acknowledged', hostId: host.id, name: 'Acknowledged CPU', metric: 'cpu', status: 'acknowledged', severity: 'warning', openedAt: 1, updatedAt: 2, resolvedAt: null, value: 99, source: 'ssh-agentless', transport: 'direct' }
    const onLocalAlertAction = vi.fn()
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', localAlerts: [base, { ...base, ruleId: 'closed', status: 'closed' }, { ...base, ruleId: 'foreign', hostId: 'other-host' }], onLocalAlertAction, localAlertBusy: 'acknowledged' }
    const props = { host, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const card = (summary: typeof operations) => mode === 'grid' ? <HostGridCard {...props} operations={summary} /> : <HostListItem {...props} index={1} operations={summary} />
    const view = render(card(operations))
    openOperations()
    expect(screen.queryByTestId('local-host-alert-ack-acknowledged')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-host-alert-close-closed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-host-alert-close-foreign')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-host-alert-close-acknowledged')).toBeDisabled()
    fireEvent.click(screen.getByTestId('local-host-alert-close-acknowledged'))
    expect(onLocalAlertAction).not.toHaveBeenCalled()
    view.rerender(card({ ...operations, localAlertBusy: null, onLocalAlertAction: undefined }))
    expect(screen.queryByTestId('local-host-alert-close-acknowledged')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('host-local-alert')).toHaveLength(2)
  })

  it.each(['grid', 'list'] as const)('opens this host Services in one click from the %s view without bubbling', (mode) => {
    const onOpenWorkspace = vi.fn()
    const onSelect = vi.fn()
    const onConnect = vi.fn()
    const onParentClick = vi.fn()
    const onParentDoubleClick = vi.fn()
    const onParentKeyDown = vi.fn()
    const props = { host, isSelected: false, onOpenWorkspace, onSelect, onConnect, onEdit: vi.fn(), onDelete: vi.fn() }
    render(<div onClick={onParentClick} onDoubleClick={onParentDoubleClick} onKeyDown={onParentKeyDown}>
      {mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />}
    </div>)
    const services = screen.getByRole('button', { name: 'Services · Production API' })
    expect(services).toBeVisible()
    expect(services).toHaveTextContent('Services')
    fireEvent.click(services)
    expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith(host.id, 'services')
    fireEvent.doubleClick(services)
    fireEvent.keyDown(services, { key: 'Enter' })
    fireEvent.keyDown(services, { key: ' ' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
    expect(onParentClick).not.toHaveBeenCalled()
    expect(onParentDoubleClick).not.toHaveBeenCalled()
    expect(onParentKeyDown).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Open operations for Production API' })).toBeVisible()
  })

  it('localizes the direct Services button and its host context in Chinese', () => {
    const previousLocale = localStorage.getItem('shellbeam.locale')
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    try {
      render(<HostGridCard host={host} isSelected={false} onOpenWorkspace={vi.fn()} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
      expect(screen.getByRole('button', { name: '服务 · Production API' })).toHaveTextContent('服务')
    } finally {
      if (previousLocale) localStorage.setItem('shellbeam.locale', previousLocale)
      else localStorage.removeItem('shellbeam.locale')
    }
  })

  it.each(['grid', 'list'] as const)('shows actual Komari sync metadata separately in the %s host card', (mode) => {
    const probe = { integrationId: 'komari', nodeId: 'node', hostId: host.id, mapping: { hostId: host.id, nodeId: 'node' }, status: 'linked', alertState: null, komari: { state: 'online', sampledAt: 1000, receivedAt: 1100, lastSyncedAt: 2000, alerts: null, snapshot: null }, probe: { state: 'not-recorded', health: null, version: null, lastHeartbeatAt: null, record: null }, recommendedAction: 'none' } as unknown as KomariProbeLink
    const operations = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct' as const, sampledAt: 1000, komariProbe: probe }
    const props = { host, isSelected: false, operations, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    openOperations()
    const disclosure = screen.getByTestId('host-data-source-details')
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.getByTestId('host-current-source')).toBeVisible()
    expect(screen.getByTestId('komari-probe-ops-view')).not.toBeVisible()
    fireEvent.click(disclosure.querySelector('summary')!)
    expect(screen.getByTestId('komari-probe-ops-view')).toBeVisible()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onConnect).not.toHaveBeenCalled()
    expect(screen.queryByText('Komari / Probe')).not.toBeInTheDocument()
    expect(screen.queryByText('ShellBeam Probe')).not.toBeInTheDocument()
    expect(screen.getByTestId('komari-host-last-sync').querySelector('time')).toHaveAttribute('datetime', new Date(2000).toISOString())
  })
  it.each(['grid', 'list'] as const)('omits empty data-source and optional Probe panels for an unconfigured %s host', (mode) => {
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct' }
    const props = { host, isSelected: false, operations, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.queryByTestId('host-data-source-details')).not.toBeInTheDocument()
    expect(screen.queryByTestId('komari-probe-ops-view')).not.toBeInTheDocument()
    expect(screen.queryByText('ShellBeam Probe')).not.toBeInTheDocument()
  })
  it.each(['grid', 'list'] as const)('keeps another monitoring source waiting or unhealthy visible outside collapsed details in %s', (mode) => {
    const link = { integrationId: 'komari', nodeId: 'node', hostId: host.id, mapping: { hostId: host.id, nodeId: 'node' }, status: 'linked', alertState: null, komari: { state: 'unknown', waitingForFirstReport: true, sampledAt: null, receivedAt: null, lastSyncedAt: 2000, alerts: null, snapshot: null }, probe: { state: 'not-recorded', health: null, version: null, lastHeartbeatAt: null, record: null }, recommendedAction: 'none' } as unknown as KomariProbeLink
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', provider: 'ssh-agentless', sampledAt: Date.now(), probeState: 'fresh' }
    const props = { host, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const card = (komariProbe: KomariProbeLink) => mode === 'grid' ? <HostGridCard {...props} operations={{ ...operations, komariProbe }} /> : <HostListItem {...props} index={1} operations={{ ...operations, komariProbe }} />
    const view = render(card(link))
    expect(screen.getByTestId('host-ops-compact-source')).toBeVisible()
    expect(screen.getByTestId('host-ops-compact-source')).toHaveTextContent('SSH')
    expect(screen.getByTestId('host-data-source-details')).not.toHaveAttribute('open')
    expect(screen.getByTestId('host-monitoring-source-attention')).toBeVisible()
    expect(screen.getByTestId('host-monitoring-source-attention')).toHaveTextContent('Waiting for first report')
    for (const state of ['stale', 'offline', 'unknown'] as const) {
      view.rerender(card({ ...link, komari: { ...link.komari, state, waitingForFirstReport: false } }))
      expect(screen.getByTestId('host-monitoring-source-attention')).toBeVisible()
      expect(screen.getByTestId('host-monitoring-source-attention')).toHaveAttribute('data-state', state)
      expect(screen.getByTestId('host-data-source-details')).not.toHaveAttribute('open')
    }
    view.rerender(card({ ...link, komari: { ...link.komari, state: 'online', waitingForFirstReport: false } }))
    expect(screen.queryByTestId('host-monitoring-source-attention')).not.toBeInTheDocument()
  })
  it.each(['grid', 'list'] as const)('explains TTL expiry in the %s card and removes it for fresh data', (mode) => {
    const operations = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct' as const, ttlMs: 60_000, expiryReason: 'ttl-expired' as const }
    const props = { host, isSelected: false, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const renderCard = (expiryReason: 'ttl-expired' | null) => mode === 'grid'
      ? <HostGridCard {...props} operations={{ ...operations, expiryReason }} />
      : <HostListItem {...props} index={1} operations={{ ...operations, expiryReason }} />
    const view = render(renderCard('ttl-expired'))
    openOperations()
    fireEvent.click(screen.getByTestId('host-data-source-details').querySelector('summary')!)
    expect(screen.getByTestId('host-ops-expiry-reason')).toBeVisible()
    expect(screen.getByTestId('host-ops-expiry-reason')).toHaveTextContent('Sample TTL expired')
    view.rerender(renderCard(null))
    expect(screen.queryByTestId('host-ops-expiry-reason')).not.toBeInTheDocument()
  })
  it.each(['grid', 'list'] as const)('routes %s shortcuts to the exact host and keeps keyboard navigation inside the control', (view) => {
    const onOpenWorkspace = vi.fn()
    const onRefresh = vi.fn()
    const onSelect = vi.fn()
    const onConnect = vi.fn()
    const props = { host, isSelected: false, onOpenWorkspace, onRefresh, onSelect, onConnect, onEdit: vi.fn(), onDelete: vi.fn() }
    render(view === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    const shortcuts = screen.getByRole('combobox', { name: 'Open operations for Production API' })
    for (const app of ['overview', 'fileSystem', 'services', 'logs', 'network']) {
      fireEvent.change(shortcuts, { target: { value: app } })
      expect(onOpenWorkspace).toHaveBeenLastCalledWith(host.id, app)
    }
    fireEvent.change(shortcuts, { target: { value: 'refresh' } })
    expect(onRefresh).toHaveBeenCalledWith(host.id)
    expect(onOpenWorkspace).toHaveBeenCalledTimes(5)
    fireEvent.click(shortcuts)
    fireEvent.doubleClick(shortcuts)
    fireEvent.keyDown(shortcuts, { key: ' ' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it.each(['grid', 'list'] as const)('shows unsupported distinctly in the %s operations card', (mode) => {
    const props = { host, isSelected: false, status: 'unsupported' as const, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByText('Unsupported monitoring')).toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('shows sampled network throughput and uptime explicitly in the %s view', (mode) => {
    const props = { host, isSelected: false, resource: oldResource, metrics: sampledMetrics, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByText('Network throughput')).toBeVisible()
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↓ 1.0 KB/s · ↑ 2.0 KB/s')
    expect(screen.getByText('Uptime')).toBeVisible()
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('1d 1h')
    expect(screen.queryByText('old uptime')).not.toBeInTheDocument()
    expect(screen.queryByText('old throughput')).not.toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'CPU 15%' })).toBeInTheDocument()
  })

  it.each(['grid', 'list'] as const)('keeps missing %s observations unknown while preserving a genuinely observed zero', (mode) => {
    const props = { host, isSelected: false, resource: oldResource, metrics: { ...sampledMetrics, uptimeSeconds: null, networkRxBytesPerSec: 0, networkTxBytesPerSec: null }, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
    const view = render(mode === 'grid' ? <HostGridCard {...props} /> : <HostListItem {...props} index={1} />)
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↓ 0 B/s · ↑ Unknown')
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('Unknown')
    const missing = { ...props, metrics: undefined, resource: undefined }
    view.rerender(mode === 'grid' ? <HostGridCard {...missing} /> : <HostListItem {...missing} index={1} />)
    expect(screen.queryByTestId('host-resource-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-resource-throughput')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-resource-uptime')).not.toBeInTheDocument()
  })

  it('retains available legacy inventory values when no metric observation exists', () => {
    render(<HostGridCard host={host} isSelected={false} resource={{ ...oldResource, uptime: '3 days', network: '12.5 KB/s' }} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('12.5 KB/s')
    expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('3 days')
  })

  it('localizes throughput, uptime and unknown values in Chinese', () => {
    const previousLocale = localStorage.getItem('shellbeam.locale')
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    try {
      const props = { host, isSelected: false, metrics: { ...sampledMetrics, uptimeSeconds: 42, networkTxBytesPerSec: null }, onSelect: vi.fn(), onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
      render(<HostGridCard {...props} />)
      expect(screen.getByText('网络吞吐')).toBeVisible()
      expect(screen.getByText('运行时间')).toBeVisible()
      expect(screen.getByTestId('host-resource-throughput')).toHaveTextContent('↑ 未知')
      expect(screen.getByTestId('host-resource-uptime')).toHaveTextContent('42 秒')
    } finally {
      if (previousLocale) localStorage.setItem('shellbeam.locale', previousLocale)
      else localStorage.removeItem('shellbeam.locale')
    }
  })

  it('renders cached region and system icons in list mode', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        network={{
          address: host.address,
          addressType: 'ipv4',
          scope: 'public',
          versionLabel: 'IPv4',
          scopeLabel: 'Public IP',
          locationLabel: 'Region pending',
          publicIp: host.address,
          canLookupLocation: true,
          resolvedLocationLabel: 'Hong Kong',
          locationStatus: 'ready',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('Hong Kong')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument()
    expect(document.querySelector('img[src="https://flagcdn.com/24x18/hk.png"]')).toBeTruthy()
    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="cpu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="memory"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="disk"]')).toBeTruthy()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('critical')).toBeInTheDocument()
  })

  it('keeps the host avatar OS-specific with a local icon asset', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(screen.queryByText('Ub')).not.toBeInTheDocument()
  })

  it('shows the configured jump host in list metadata', () => {
    render(
      <HostListItem
        index={1}
        host={{ ...host, jumpHost: 'bastion.example.com', jumpPort: 2200, jumpUser: 'jump' }}
        isSelected={false}
        status="online"
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-host-jump-pill]')).toBeTruthy()
    expect(screen.getByText(/bastion\.example\.com:2200/)).toBeInTheDocument()
  })

  it('shows resolved reference metadata and never copies old jump endpoints', () => {
    render(<HostListItem index={1} host={{ ...host, jumpHostId: 'jump-1', jumpHost: 'old-bastion', jumpPort: 22, jumpUser: 'old-user' }} isSelected={false} operations={{ serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'proxy-jump', jumpHost: 'edited-bastion', jumpPort: 2200, jumpUser: 'current-user' }} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(/current-user@edited-bastion:2200/)).toBeInTheDocument()
    expect(screen.queryByText(/old-bastion|old-user/)).not.toBeInTheDocument()
  })

  it('shows service, process and operation summaries for the ops view', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="stale"
        operations={{
          serviceTotal: 4,
          serviceActive: 3,
          serviceFailed: 1,
          processTotal: 2,
          processRunning: 2,
          auditCount: 3,
          auditActive: 1,
          auditUnknown: 2,
          latestAudit: {
            action: 'service.restart',
            target: 'nginx.service',
            status: 'completed',
            createdAt: 1000,
            transport: 'direct',
            provider: 'ssh-agentless',
            auditId: 'audit-1',
            source: 'mcp',
          },
          provider: 'ssh-agentless',
          sampledAt: 1000,
          probeState: 'recovered',
          probeProviderId: 'ssh-agentless',
          probeTelemetry: {
            status: 'recovered',
            startedAt: 900,
            completedAt: 1000,
            durationMs: 100,
            attempts: 2,
            maxRetries: 2,
            retryDelayMs: 150,
            recovered: true,
            exhausted: true,
            sections: ['metrics'],
          },
          transport: 'direct',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    openOperations()
    const details = within(screen.getByTestId('host-ops-details'))
    expect(screen.getByTestId('host-ops-summary')).toBeVisible()
    expect(details.getByText('3/4')).toBeInTheDocument()
    expect(details.getByText('2/2')).toBeVisible()
    expect(details.getByText(/service\.restart/)).toBeVisible()
    expect(details.getByText(/audit-1/)).toBeVisible()
    expect(details.getByText(/Unknown: 2/)).toBeVisible()
    fireEvent.click(screen.getByTestId('host-data-source-details').querySelector('summary')!)
    expect(details.getByText(/2 retries/)).toBeVisible()
  })

  it('surfaces MCP alert lifecycle and linked OperationJob outcome in the host ops row', () => {
    const link = {
      integrationId: 'komari-prod',
      nodeId: 'node-1',
      hostId: host.id,
      mapping: { integrationId: 'komari-prod', hostId: host.id, nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 },
      status: 'linked',
      alertState: {
        schemaVersion: 1,
        alerts: [
          { alertId: 'alert-active', nodeId: 'node-1', hostId: host.id, status: 'active', relatedOperationJobId: null },
          { alertId: 'alert-ack', nodeId: 'node-1', hostId: host.id, status: 'acknowledged', relatedOperationJobId: 'job-ack' },
          { alertId: 'alert-closed', nodeId: 'node-1', hostId: host.id, status: 'closed', relatedOperationJobId: null },
        ],
        audit: [{ alertId: 'alert-ack', operationJobId: 'job-ack', event: 'acknowledged', at: 2_000 }],
        summary: {},
      },
      komari: { state: 'online', sampledAt: 1_000, receivedAt: 1_000, alerts: { load: 0, offline: 0, total: 3, active: 1, updatedAt: 1_000 }, snapshot: null },
      probe: { state: 'installed', health: 'online', version: '1.0.0', lastHeartbeatAt: 1_000, record: { capabilities: [] } },
      recommendedAction: 'none',
    } as unknown as KomariProbeLink
    const audit: OperationAuditEntry = {
      auditId: 'audit-ack',
      jobId: 'job-ack',
      hostId: host.id,
      hostName: host.name,
      hostAddress: host.address,
      source: 'mcp',
      actor: 'mcp-client:test',
      action: 'mcp.acknowledge_server_alert',
      target: 'alert-ack',
      risk: 'low',
      provider: 'komari-alert',
      transport: 'local',
      event: 'updated',
      status: 'completed',
      confirmationStatus: 'not_required',
      createdAt: 2_000,
    }
    const alertAudit: KomariAlertAuditEntry = {
      auditId: 'alert-audit-ack',
      alertId: 'alert-ack',
      fingerprint: 'komari-prod|node-1|host-1|load',
      event: 'acknowledged',
      status: 'acknowledged',
      actor: 'mcp-client:test',
      operationJobId: 'job-ack',
      at: 2_000,
    }

    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        operations={{
          serviceTotal: null,
          serviceActive: null,
          serviceFailed: null,
          processTotal: null,
          processRunning: null,
          auditCount: 1,
          latestAudit: audit,
          audits: [audit],
          komariAlertAudits: [alertAudit],
          provider: 'komari',
          sampledAt: 1_000,
          transport: 'direct',
          komariProbe: link,
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    openOperations()
    fireEvent.click(screen.getByTestId('host-data-source-details').querySelector('summary')!)
    expect(screen.getByText('2 open alert(s)')).toBeVisible()
    expect(screen.getByText('Acknowledged: 1')).toBeInTheDocument()
    expect(screen.getByText('Closed: 1')).toBeInTheDocument()
    expect(screen.getByText('job job-ack · completed')).toBeInTheDocument()
    expect(screen.getByTestId('host-ops-alert-audit')).toHaveTextContent('Acknowledged')
    expect(screen.getByTestId('host-ops-alert-audit')).toHaveTextContent('mcp-client:test')
  })

  it('runs acknowledge and close actions from the host ops alert context', async () => {
    const activeAlert: KomariAlertRecord = {
      schemaVersion: 1,
      source: 'komari',
      alertId: 'alert-active-card',
      fingerprint: 'komari-prod|node-1|host-1|offline',
      integrationId: 'komari-prod',
      nodeId: 'node-1',
      hostId: host.id,
      kind: 'offline',
      title: 'Offline host',
      severity: 'critical',
      count: 1,
      status: 'active',
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      closedAt: null,
      relatedOperationJobId: null,
      deduplicatedCount: 0,
    }
    const acknowledgedAlert: KomariAlertRecord = {
      ...activeAlert,
      alertId: 'alert-ack-card',
      fingerprint: 'komari-prod|node-1|host-1|load',
      kind: 'load',
      title: 'Load alert',
      severity: 'warning',
      status: 'acknowledged',
      acknowledgedAt: 1_100,
      acknowledgedBy: 'mcp-client:test',
      relatedOperationJobId: 'job-ack-card',
    }
    const onKomariAlertAction = vi.fn()

    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        operations={{
          serviceTotal: null,
          serviceActive: null,
          serviceFailed: null,
          processTotal: null,
          processRunning: null,
          auditCount: 0,
          transport: 'direct',
          komariAlerts: [activeAlert, acknowledgedAlert],
          onKomariAlertAction,
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    openOperations()
    expect(screen.getByTestId('komari-host-alert-ack-alert-active-card')).toBeVisible()
    fireEvent.click(screen.getByTestId('komari-host-alert-ack-alert-active-card'))
    await waitFor(() => expect(onKomariAlertAction).toHaveBeenCalledWith('acknowledge', activeAlert))

    fireEvent.click(screen.getByTestId('komari-host-alert-close-alert-ack-card'))
    await waitFor(() => expect(onKomariAlertAction).toHaveBeenCalledWith('close', acknowledgedAlert))
  })
  it('exposes one visible action row for a legacy missing-observation incident and keeps its stored metrics ID', () => {
    const metrics: KomariAlertRecord = { schemaVersion: 1, source: 'komari', alertId: 'missing-metrics', fingerprint: 'missing-metrics', integrationId: 'komari', nodeId: 'node', hostId: host.id, kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations', severity: 'warning', count: 1, status: 'active', firstSeenAt: 1000, lastSeenAt: 1000, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, closedAt: null, relatedOperationJobId: null, deduplicatedCount: 0 }
    const unknown: KomariAlertRecord = { ...metrics, alertId: 'missing-health', fingerprint: 'missing-health', kind: 'probe-unknown', title: 'Komari Probe health is unknown' }
    const retry: KomariAlertRecord = { ...metrics, alertId: 'missing-retries', fingerprint: 'missing-retries', kind: 'probe-error:provider', title: 'Komari Probe provider error: Probe recovery failed after 3 retries: Komari returned no dated metric observations', severity: 'critical' }
    const onKomariAlertAction = vi.fn()
    const operations: HostOperationalSummary = { serviceTotal: null, serviceActive: null, serviceFailed: null, processTotal: null, processRunning: null, auditCount: 0, transport: 'direct', probeState: 'error', komariAlerts: [unknown, retry, metrics], onKomariAlertAction }
    render(<HostListItem index={1} host={host} isSelected={false} operations={operations} onSelect={vi.fn()} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByTestId('host-data-source-details')).not.toHaveAttribute('open')
    openOperations()
    expect(screen.getByTestId('host-ops-alert-actions')).toBeVisible()
    expect(screen.queryByTestId('komari-host-alert-ack-missing-health')).not.toBeInTheDocument()
    expect(screen.queryByTestId('komari-host-alert-ack-missing-retries')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('komari-host-alert-ack-missing-metrics'))
    expect(onKomariAlertAction).toHaveBeenCalledWith('acknowledge', expect.objectContaining({ alertId: metrics.alertId, severity: 'warning' }))
    fireEvent.click(screen.getByTestId('komari-host-alert-close-missing-metrics'))
    expect(onKomariAlertAction).toHaveBeenCalledWith('close', expect.objectContaining({ alertId: metrics.alertId }))
    expect(operations.komariAlerts).toEqual([unknown, retry, metrics])
  })
})
