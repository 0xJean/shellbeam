import assert from 'node:assert/strict'
import { reviewed, serverIdentity, verifyFreshCpu } from './monitoring-agent-ui-evidence.mjs'

export function verifyMonitoringAgentUiReport(r) {
  assert(r.success && r.cleanup && r.applicationStopped)
  assert(/^[a-f0-9]{40}$/.test(r.headCommit) && /^[a-f0-9]{40}$/.test(r.checkedOutCommit))
  const j = r.journey
  assert(j?.passed && j.installedPackage && j.productionIpc && j.realVault && j.nativeShellBeamPages)
  assert(j.installs === 2 && j.upgrades === 2 && j.rollbacks === 1 && j.readonlyRecovery === 1 && j.restoredAuditJobs === 8 && j.noReplayMs === 5000)
  const event = name => { const values = r.events.filter(e => e.name === name); assert.equal(values.length, 1, name); return values[0] }
  const servers = r.events.filter(e => e.name === 'agent-server-identity-verified')
  assert.deepEqual(servers.map(s => s.service), [0, 1])
  assert(servers.every(s => s.product === serverIdentity.product && s.commit === serverIdentity.hash && /^[a-f0-9]{64}$/.test(s.binarySha256)))
  const p = event('agent-production-release-verified')
  assert(p.keyId === 'compatible-probe-2026-01' && p.sequence > 1792594908584 && p.version === '1.5.12' && p.signatureVerified && p.historicalCatalogPinned)
  assert(['amd64', 'arm64'].includes(p.architecture)); assert(event('agent-no-user-key-configuration').passed)
  const names = ['agent-fresh-install', 'agent-old-install', 'agent-upgraded', 'agent-rolled-back', 'agent-reupgrade-recovered']
  for (const [i, name] of names.entries()) {
    const e = event(name), version = i === 1 || i === 3 ? '1.5.11' : '1.5.12'
    assert.equal(e.version, version); verifyFreshCpu({ time: e.originalSampleAt, cpu: e.cpu }, e)
    assert.equal(e.processSha256, reviewed[version][p.architecture].sha256)
    assert(e.configurationRetained && e.nodeAndTokenRetained)
  }
  const recovery = event('agent-interrupted-readonly-recovery'); assert(recovery.passed && recovery.noReplayMs === 5000 && recovery.unknownAuditRetained)
  const audit = event('agent-audit-restored')
  assert(audit.passed && audit.noReplayMs === 5000 && audit.allProbesStopped && audit.nodeCredentialsAndHistoryRetained && audit.jobs.length === 8)
  assert(audit.sameVaultOwnerRetained && audit.auditScopesRetained)
  assert.equal(new Set(audit.jobs.map(j => j.id)).size, 8)
  assert(audit.jobs.every(j => /^[a-f0-9-]{36}$/.test(j.id) && ['completed', 'unknown'].includes(j.status)))
  assert.equal(audit.jobs.filter(j => j.status === 'unknown').length, 1)
  const scopes = new Map()
  for (const job of audit.jobs) {
    assert(/^[a-f0-9-]{36}$/.test(job.hostId))
    assert(['ssh-direct', 'ssh-proxyjump'].includes(job.transport))
    if (scopes.has(job.hostId)) assert.equal(scopes.get(job.hostId), job.transport)
    scopes.set(job.hostId, job.transport)
  }
  assert.equal(scopes.size, 2); assert.equal(new Set(scopes.values()).size, 2)
  assert.deepEqual(audit.jobs.map(j => j.action).sort(), ['install', 'install', 'upgrade', 'upgrade', 'rollback', 'inspect', 'uninstall', 'uninstall'].map(a => `monitoring.agent.${a}`).sort())
  assert.equal(audit.jobs.find(j => j.status === 'unknown').action, 'monitoring.agent.upgrade')
  assert(audit.auditRowVisible && audit.jobs.some(j => j.id === audit.auditRowJobId && j.status === audit.auditRowStatus))
  const history = r.events.filter(e => e.name === 'agent-history-retained'); assert.deepEqual(history.map(e => e.role), ['source', 'target'])
  for (const h of history) assert(h.originalBuckets?.length && h.originalBuckets.every(t => Number.isSafeInteger(t) && t > 0 && t <= h.checkedAt) && h.retainedBuckets >= h.originalBuckets.length)
  const cleanup = event('transfer-fixture-cleaned'); assert(cleanup.containersRemoved && cleanup.networkRemoved && cleanup.serversStopped)
  assert.deepEqual(r.screenshots.map(s => s.file), [...names, 'agent-audit-restored'].map(s => s + '.png'))
  for (const s of r.screenshots) assert(/^[a-f0-9]{64}$/.test(s.sha256) && s.bytes > 1000 && s.bytes < 8 * 1024 * 1024 && s.width > 0 && s.height > 0)
  return true
}
