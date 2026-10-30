import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { initializeOpsUiVault } from './ops-ui-journey.mjs'
import { bounded } from './extension-ui-fixture.mjs'

const id=name=>`[data-testid="${name}"]`
const root=id('monitoring-service-panel'), history=id('monitoring-service-history'), rows=id('monitoring-service-intent')
const button=text=>`xpath=//*[@data-testid="komari-settings"]//button[normalize-space(.)=${JSON.stringify(text)}]`
const row=idValue=>`${rows}[data-intent-id="${idValue}"]`
async function idle(d){await d.until(async()=>await d.attr(root,'data-busy')==='false',{timeoutMs:120000})}
async function openHistory(d){await d.waitFor(history);if(await d.attr(history,'open')===null)await d.click(history+' > summary')}
async function openService(d,s) {
  await d.click(id('pc-dashboard'));await d.click(id('pc-nav-settings'));await d.click(id('settings-category-monitoring'));await d.click(id('monitor-tab-server'))
  await d.click(`xpath=//*[@id="monitor-tab-panel"]//button[@aria-pressed][.//span[normalize-space(.)=${JSON.stringify(s.name)}]]`)
  await d.waitFor(root);if(await d.attr(root,'open')===null)await d.click(root+' > summary')
  await d.select(id('monitoring-service-target'),'load-policy');await idle(d)
  assert.equal((await d.findAll('iframe')).length,0,'extension_ui_second_frontend')
  assert.equal((await d.findAll('#komari-api-key')).length,0,'extension_ui_credential_visible')
}
async function confirm(d,s,accept=true){
  const selector=`dialog[open] ${id('user-confirmation')}`;await d.waitFor(selector)
  assert.equal(await d.attr(selector,'data-risk'),'high')
  assert((await d.text(id('user-confirmation-message'))).includes(s.name),'extension_ui_confirmation_service')
  await d.click(id('user-confirmation-'+(accept?'accept':'cancel')))
  await d.until(async()=>!(await d.findAll(selector)).length)
}
async function check(d,installed,version){
  await d.click(id('extension-check'));await idle(d)
  assert.equal(await d.attr(id('extension-status'),'data-installed'),String(installed))
  if(installed){assert.equal(await d.attr(id('extension-status'),'data-version'),version);assert.equal(await d.attr(id('extension-status'),'data-running'),'true')}
}
async function intents(d){
  await openHistory(d);const result=[]
  for(const element of await d.findAll(rows))result.push({id:await d.attr(element,'data-intent-id'),job:await d.attr(element,'data-job-id'),status:await d.attr(element,'data-status'),operation:await d.attr(element,'data-operation'),backup:await d.attr(element,'data-backup')==='true',stage:await d.attr(element,'data-stage')})
  return result
}
async function operation(d,s,control,previous=[],accept=true){
  await d.click(control);await confirm(d,s,accept);await idle(d)
  if(!accept)return
  const next=(await intents(d)).filter(x=>!previous.includes(x.id));assert.equal(next.length,1,'extension_ui_unique_new_intent');assert.equal(next[0].status,'verified','extension_ui_not_verified');return next[0]
}
export function assertPreserved(actual,original,version){
  assert(actual.installed && actual.enabled && actual.running);assert.equal(actual.version,version)
  for(const k of ['identity','revision','policy','events','receipts','future'])assert.deepEqual(actual.state[k],original.state[k],'extension_ui_retained_'+k)
  for(const [k,v] of Object.entries(original.state.evaluations))assert.deepEqual(actual.state.evaluations[k],v,'extension_ui_retained_dispatch')
  assert.deepEqual(actual.configuration,original.configuration,'extension_ui_retained_configuration')
}
async function stable(s,ms=5000){
  const writes=s.gateway.mutations().length,before=await s.observe();await delay(ms)
  assert.equal(s.gateway.mutations().length,writes,'extension_ui_automatic_write')
  // Stopped extensions must retain the exact complete observation. A running
  // evaluator can add observations but cannot change identity/policy/receipts.
  const after=await s.observe()
  if(before.running)assertPreserved(after,before,before.version);else assert.deepEqual(after,before)
}
async function audit(d,expected) {
  await d.click(id('pc-dashboard'));await d.click(id('pc-nav-activity'));await d.click(id('history-tab-audit'));await d.click(id('audit-tab'));await d.click(id('operations-refresh'))
  const found=new Map();let selected
  for(let page=0;page<30;page++) {
    await d.waitFor(id('operation-audit-row'));selected=undefined
    for(const element of await d.findAll(id('operation-audit-row'))) {
      const job=await d.attr(element,'data-job-id'),status=await d.attr(element,'data-status')
      if(expected.some(e=>e.id===job&&e.status===status)){found.set(job,status);if(!selected||status==='unknown')selected={id:job,status}}
    }
    if(found.size===expected.length)break
    if(!await d.isEnabled(id('operations-older')))break
    const before=await d.text(id('operations-page'));await d.click(id('operations-older'));await d.until(async()=>await d.text(id('operations-page'))!==before)
  }
  assert.equal(found.size,expected.length,'extension_ui_audit_not_restored');assert(selected);return selected
}
export async function revealExtensionAudit(d,expected) {
  assert(/^[a-f0-9-]{36}$/.test(expected.id)&&['completed','unknown','failed','cancelled'].includes(expected.status))
  const target=`${id('operation-audit-row')}[data-job-id="${expected.id}"][data-status="${expected.status}"]`
  // An inert audit row has no action handler. One native click on its first
  // cell reveals it (the row can be wider than the table's scroll area);
  // subsequent inspection is read-only and must prove both axes for that cell.
  const cell=`${target} td:first-child`
  await d.click(cell)
  await d.until(async()=>{
    const box=await d.rect(cell)
    const width=Number(await d.request('GET',await d.elementRoute('html','/property/clientWidth')))
    const height=Number(await d.request('GET',await d.elementRoute('html','/property/clientHeight')))
    return [box.x,box.y,box.width,box.height,width,height].every(Number.isFinite)&&box.width>0&&box.height>0&&box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height
  })
  assert.equal(await d.attr(target,'data-job-id'),expected.id);assert.equal(await d.attr(target,'data-status'),expected.status)
  return {auditRowVisible:true,auditRowJobId:expected.id,auditRowStatus:expected.status}
}

export async function setupExtensionUi({driver:d,fixture:f,record}) {
  const password='Ui1'+randomBytes(24).toString('hex');await initializeOpsUiVault({driver:d,password,record})
  for(const s of f.services) {
    await d.click(id('pc-dashboard'));await d.click(id('pc-nav-settings'));await d.click(id('settings-category-monitoring'));await d.click(id('monitor-tab-services'))
    await d.click(button('Add monitoring service'));await d.fill('#komari-name',s.name);await d.fill('#komari-endpoint',s.endpoint)
    await d.click('xpath=//*[@data-testid="komari-settings"]//label[input[@type="radio" and @value="key"]]');await d.fill('#komari-api-key',s.apiKey)
    const enabled='xpath=//*[@data-testid="komari-settings"]//label[contains(.,"Enable monitoring connection")]/input[@type="checkbox"]'
    if(!await d.isSelected(enabled))await d.click(enabled)
    await d.click(button('Save connection'));await d.until(async()=>await d.attr('#komari-api-key','value')==='')
    await d.click(id('monitor-tab-server'));await d.waitFor(root);record('extension-service-saved',{role:s.role,credentialsSaved:true})
  }
  return {password}
}

export async function runExtensionUiJourney({driver,fixture:f,state,record,restart,checkpoint,observeAudit}) {
  let d=driver;const [fresh,legacy]=f.services;const jobs=new Map()
  const remember=(value,status='completed')=>jobs.set(value.job??value.id,status)
  await openService(d,fresh);await check(d,false)
  const credentials=observeAudit().credentialFingerprint
  const before=fresh.gateway.mutations().length
  await operation(d,fresh,id('extension-install'),[],false)
  assert.equal(fresh.gateway.mutations().length,before);assert.deepEqual(await fresh.observe(),{installed:false})
  record('extension-cancelled-without-mutation',{passed:true})
  const install=await operation(d,fresh,id('extension-install'));remember(install)
  await check(d,true,'0.2.0');const original=await fresh.observe()
  record('extension-app-installed',{version:'0.2.0',fixedBytes:true,explicitConfirmation:true});await checkpoint('extension-installed')
  const removed=await operation(d,fresh,id('extension-uninstall'),[install.id]);remember(removed);assert(removed.backup)
  assert.deepEqual(await fresh.observe(),{installed:false});await check(d,false)
  record('extension-app-uninstalled',{backupRetained:true,explicitConfirmation:true});await checkpoint('extension-uninstalled')
  d=await restart(state.password);await openService(d,fresh);await stable(fresh)
  const saved=(await intents(d)).find(x=>x.id===removed.id);assert(saved?.backup&&saved.job===removed.job)
  const restored=await operation(d,fresh,`${row(saved.id)} ${id('extension-restore')}`,[install.id,removed.id]);remember(restored)
  assertPreserved(await fresh.observe(),original,'0.2.0');await check(d,true,'0.2.0')
  record('extension-app-restored-after-restart',{originalIdentity:true,encryptedBackupReopened:true,noReplayMs:5000});await checkpoint('extension-restored')

  // Lose the successful merge response, then kill the real App. The same
  // retained checkpoint must finish without uploading/replacing twice.
  await openService(d,legacy);await check(d,true,'0.1.0');legacy.gateway.arm('after-merge')
  await d.click(id('extension-upgrade'));await confirm(d,legacy)
  await bounded(()=>legacy.gateway.gate.held===1)
  const first=observeAudit();const interruptedUpgrade=first.intents.find(x=>x.status==='applying');assert(interruptedUpgrade&&interruptedUpgrade.encrypted)
  const pending=await legacy.observe();assert.equal(pending.version,'0.2.0');assert.equal(pending.running,false)
  d=await restart(state.password);legacy.gateway.release();await openService(d,legacy);await stable(legacy)
  let savedUpgrade=(await intents(d)).find(x=>x.id===interruptedUpgrade.id);assert(savedUpgrade?.backup&&savedUpgrade.stage==='replace-dispatched')
  remember({job:interruptedUpgrade.job},'unknown')
  await d.click(`${row(savedUpgrade.id)} ${id('extension-reconcile')}`);await idle(d);await stable(legacy)
  savedUpgrade=(await intents(d)).find(x=>x.id===savedUpgrade.id);assert.equal(savedUpgrade.status,'retry');remember(savedUpgrade,'failed')
  const merges=legacy.gateway.mutations().filter(r=>r.path==='/api/admin/upload/merge').length
  const completed=await operation(d,legacy,`${row(savedUpgrade.id)} ${id('extension-retry')}`,[savedUpgrade.id]);remember(completed)
  assert.equal(legacy.gateway.mutations().filter(r=>r.path==='/api/admin/upload/merge').length,merges,'extension_ui_duplicate_merge')
  assertPreserved(await legacy.observe(),legacy.original,'0.2.0');await check(d,true,'0.2.0')
  record('extension-app-upgrade-recovered',{originalVersion:'0.1.0',version:'0.2.0',responseLost:true,unknownJobRetained:true,noDuplicateMerge:true,stateAndConfigurationRetained:true,unknownDispatchRetained:true,noReplayMs:5000});await checkpoint('extension-upgrade-recovered')

  // Stop and persist a backup, but do not forward deletion. Restoration is
  // chosen explicitly after crash, instead of automatically completing it.
  const existing=(await intents(d)).map(x=>x.id);legacy.gateway.arm('before-delete')
  await d.click(id('extension-uninstall'));await confirm(d,legacy);await bounded(()=>legacy.gateway.gate.held===1)
  const interruptedRemoval=observeAudit().intents.find(x=>x.status==='applying');assert(interruptedRemoval?.encrypted)
  const stopped=await legacy.observe();assert.equal(stopped.running,false);assert.equal(stopped.installed,true)
  d=await restart(state.password);legacy.gateway.release();await openService(d,legacy);await stable(legacy)
  const recovery=(await intents(d)).find(x=>x.id===interruptedRemoval.id);assert(recovery?.backup&&recovery.stage==='delete-dispatched');remember({job:interruptedRemoval.job},'unknown')
  await d.click(`${row(recovery.id)} ${id('extension-reconcile')}`);await idle(d);await stable(legacy)
  const readback=(await intents(d)).find(x=>x.id===recovery.id);assert.equal(readback.status,'retry');remember(readback,'failed')
  const deletionCount=legacy.gateway.mutations().filter(r=>r.path==='/api/admin/plugin/delete').length
  const undo=await operation(d,legacy,`${row(recovery.id)} ${id('extension-restore')}`,[...existing,recovery.id]);remember(undo)
  assert.equal(legacy.gateway.mutations().filter(r=>r.path==='/api/admin/plugin/delete').length,deletionCount)
  assertPreserved(await legacy.observe(),legacy.original,'0.2.0');await check(d,true,'0.2.0')
  record('extension-app-interrupted-removal-restored',{backupBeforeDelete:true,originalIdentity:true,unknownDispatchRetained:true,explicitRestore:true,noReplayMs:5000});await checkpoint('extension-removal-recovered')

  // A retained backup is never permission to overwrite a running instance.
  const existingIds=(await intents(d)).map(x=>x.id),writes=legacy.gateway.mutations().length
  await d.click(`${row(recovery.id)} ${id('extension-restore')}`);await confirm(d,legacy);await idle(d)
  const rejected=(await intents(d)).filter(x=>!existingIds.includes(x.id));assert.equal(rejected.length,1);assert.equal(rejected[0].status,'uncertain');remember(rejected[0],'unknown')
  assert.equal(legacy.gateway.mutations().length,writes,'extension_ui_running_state_overwritten')
  record('extension-app-conflict-preserved',{runningStateNotOverwritten:true,backupRetained:true})

  d=await restart(state.password)
  for(const s of f.services){await openService(d,s);await stable(s);await check(d,true,'0.2.0');record('extension-retained-node-history',{role:s.role,...await s.retained(),credentialStillWorks:true})}
  assertPreserved(await legacy.observe(),legacy.original,'0.2.0');assertPreserved(await fresh.observe(),original,'0.2.0')
  const persisted=observeAudit();assert.equal(persisted.credentialFingerprint,credentials,'extension_ui_credential_records_changed');assert(persisted.intents.every(i=>i.encrypted),'extension_ui_plaintext_backup')
  for(const [job,status] of jobs){const actual=persisted.jobs.find(x=>x.id===job);assert.equal(actual?.status,status,'extension_ui_original_audit_rewritten')}
  // Include reconciliation/cancellation jobs as well, not just final success.
  const audits=persisted.jobs;assert(audits.length>=jobs.size);assert(audits.every(x=>x.vault===audits[0].vault && ['completed','failed','cancelled','unknown'].includes(x.status)))
  const selected=await audit(d,audits);const visible=await revealExtensionAudit(d,selected);record('extension-app-audit-restored',{...visible,jobs:audits.map(({id,status,action})=>({id,status,action})),encryptedIntents:persisted.intents.length,oneVault:true,credentialRecordsUnchanged:true});await checkpoint('extension-audit')
  assert(f.services.every(s=>s.gateway.trace.every(r=>r.path.startsWith('/api/'))),'extension_ui_web_frontend_requested')
  return {passed:true,installedPackage:true,productionIpc:true,realVault:true,nativeShellBeamPages:true,install:1,uninstall:1,restore:2,interrupted:2,upgrade:1,conflict:1,noReplayMs:5000,auditJobs:audits.length}
}
