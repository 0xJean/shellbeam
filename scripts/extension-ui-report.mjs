import assert from 'node:assert/strict'
export function verifyExtensionUiReport(r) {
  assert(r.success && r.cleanup && r.applicationStopped)
  assert(/^[a-f0-9]{40}$/.test(r.headCommit)&&/^[a-f0-9]{40}$/.test(r.checkedOutCommit))
  const j=r.journey;assert(j.passed&&j.installedPackage&&j.productionIpc&&j.realVault&&j.nativeShellBeamPages)
  for(const [key,value] of Object.entries({install:1,uninstall:1,restore:2,interrupted:2,upgrade:1,conflict:1,noReplayMs:5000}))assert.equal(j[key],value)
  const event=name=>{const e=r.events.filter(e=>e.name===name);assert.equal(e.length,1,name);return e[0]}
  const f=event('extension-fixture-ready');assert(f.officialVersion==='1.6.0'&&f.pinnedServer&&f.services===2)
  assert(event('extension-cancelled-without-mutation').passed)
  const installed=event('extension-app-installed');assert(installed.version==='0.2.0'&&installed.fixedBytes&&installed.explicitConfirmation)
  const removed=event('extension-app-uninstalled');assert(removed.backupRetained&&removed.explicitConfirmation)
  const restored=event('extension-app-restored-after-restart');assert(restored.originalIdentity&&restored.encryptedBackupReopened&&restored.noReplayMs===5000)
  const upgrade=event('extension-app-upgrade-recovered');assert(upgrade.originalVersion==='0.1.0'&&upgrade.version==='0.2.0'&&upgrade.responseLost&&upgrade.unknownJobRetained&&upgrade.noDuplicateMerge&&upgrade.stateAndConfigurationRetained&&upgrade.unknownDispatchRetained&&upgrade.noReplayMs===5000)
  const interrupted=event('extension-app-interrupted-removal-restored');assert(interrupted.backupBeforeDelete&&interrupted.originalIdentity&&interrupted.unknownDispatchRetained&&interrupted.explicitRestore&&interrupted.noReplayMs===5000)
  const conflict=event('extension-app-conflict-preserved');assert(conflict.runningStateNotOverwritten&&conflict.backupRetained)
  const history=r.events.filter(e=>e.name==='extension-retained-node-history');assert.deepEqual(history.map(e=>e.role),['fresh','legacy'])
  for(const e of history)assert(e.credentialStillWorks&&e.originalBuckets.length>0&&e.originalBuckets.every(t=>Number.isSafeInteger(t)&&t>0&&t<=e.checkedAt)&&e.retainedBuckets>=e.originalBuckets.length)
  const audit=event('extension-app-audit-restored');assert(audit.oneVault&&audit.credentialRecordsUnchanged&&audit.encryptedIntents>=8&&audit.jobs.length===j.auditJobs)
  assert.equal(new Set(audit.jobs.map(x=>x.id)).size,audit.jobs.length)
  assert(audit.jobs.every(x=>/^[a-f0-9-]{36}$/.test(x.id)&&['completed','unknown','failed','cancelled'].includes(x.status)))
  assert.equal(audit.jobs.filter(x=>x.status==='unknown').length,3)
  for(const action of ['monitoring.service.update','monitoring.extension.upgrade','monitoring.extension.uninstall','monitoring.extension.restore'])assert(audit.jobs.some(x=>x.action===action&&x.status==='completed'))
  assert.deepEqual(r.screenshots.map(s=>s.file),['installed','uninstalled','restored','upgrade-recovered','removal-recovered','audit'].map(n=>`extension-${n}.png`))
  for(const s of r.screenshots)assert(/^[a-f0-9]{64}$/.test(s.sha256)&&s.bytes>1000&&s.bytes<8*1024*1024&&s.width>0&&s.height>0)
  assert(event('extension-fixture-cleaned').serversStopped)
  return true
}
