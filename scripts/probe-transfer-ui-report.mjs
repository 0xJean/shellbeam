import assert from 'node:assert/strict'
export function verifyTransferUiReport(report) {
  assert(report.success===true && report.applicationStopped===true && report.cleanup===true)
  assert(/^[a-f0-9]{40}$/.test(report.headCommit) && /^[a-f0-9]{40}$/.test(report.checkedOutCommit))
  const j=report.journey
  assert(j?.passed && j.installedPackage && j.productionIpc && j.realVault)
  assert(j.normalMigration===1 && j.interruptedMigrations===2 && j.readonlyInspections===2 && j.explicitRestore===1 && j.explicitFinish===1 && j.restoredAuditJobs===14 && j.noReplayMs===5000)
  const event=name=>{const matches=report.events.filter(e=>e.name===name);assert.equal(matches.length,1,name);return matches[0]}
  const fixture=event('transfer-fixture-ready');assert(fixture.machineIdentitiesDistinct && fixture.services===2 && fixture.hosts===4 && fixture.productionKeyId==='compatible-probe-2026-01' && fixture.sequence>=1792594908584)
  assert(['amd64','arm64'].includes(fixture.architecture))
  for(const name of ['transfer-app-install-verified','transfer-app-cross-service-machine-account-completed','transfer-app-restore-verified','transfer-app-finish-verified']) {
    const e=event(name);assert(Number.isSafeInteger(e.originalSampleAt)&&e.originalSampleAt>e.before&&e.originalSampleAt>=e.started-5000&&e.originalSampleAt>=e.verifiedAt-60000&&e.originalSampleAt<=e.verifiedAt+5000)
    assert(/^[a-f0-9]{64}$/.test(e.processSha256))
  }
  assert(event('transfer-cancelled-without-remote-mutation').passed)
  assert(event('transfer-app-audit-history-restored').auditJobs===14)
  const history=report.events.filter(e=>e.name==='transfer-app-retained-history');assert.deepEqual(history.map(e=>e.role).sort(),['finish','restore','source','target'])
  for(const h of history)assert(h.originalBuckets?.length>0&&h.originalBuckets.every(t=>Number.isSafeInteger(t)&&t>0&&t<=h.checkedAt)&&h.retainedBuckets>=h.originalBuckets.length)
  const interrupted=report.events.filter(e=>e.name==='transfer-interrupted-recovered-in-app');assert.equal(interrupted.length,2);assert.deepEqual(interrupted.map(e=>e.action),['restore','finish']);assert(interrupted.every(e=>e.passed&&e.bothJobsRecovered&&e.noReplayMs===5000))
  const final=event('transfer-app-final-preservation-and-exit');assert(final.passed&&final.allProbesStopped&&final.auditJobs===14&&final.originalConfigurationRetained&&final.nodeCredentialsAndHistoryRetained)
  assert.equal(report.screenshots.length,5);assert.equal(new Set(report.screenshots.map(s=>s.file)).size,5)
  for(const s of report.screenshots)assert(/^transfer-[a-z-]+\.png$/.test(s.file)&&/^[a-f0-9]{64}$/.test(s.sha256)&&s.bytes>1000&&s.bytes<8*1024*1024&&s.width>0&&s.height>0)
  return true
}
