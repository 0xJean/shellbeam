// Only standard WebDriver interactions with the installed production app.
// No script execution, direct IPC, database seeding or replayed writes.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { initializeOpsUiVault, revealOpsUiHostActions } from './ops-ui-journey.mjs'
import { wait } from './probe-transfer-ui-fixture.mjs'
import { chooseServerMonitoring } from './monitoring-mode-ui.mjs'

const id = value => `[data-testid="${value}"]`
const q = value => JSON.stringify(value)
const button = (root,text) => `xpath=${root}//button[normalize-space(.)=${q(text)}]`
const card = h => `${id('host-card')}[data-host-id=${q(h.id)}]`
const panel = h => `${card(h)} ${id('compatible-agent-panel')}`
const transfer = h => `${card(h)} ${id('probe-transfer-panel')}`
const normalFingerprint=v=>String(v).trim().replace(/^SHA256:/,'').replace(/=+$/,'')
const exists=async(d,s)=>(await d.findAll(s)).length>0
const main=async(d,page='hosts')=>{await d.click(id('pc-dashboard'));await d.click(id(`pc-nav-${page}`))}
const closed=async(d,s)=>d.until(async()=>!await exists(d,s))

export function classifyTransferHostError(message) {
  if (/database is locked|database is busy/i.test(message)) return 'storage_busy'
  if (/vault.*locked|locked.*vault/i.test(message)) return 'vault_locked'
  if (/Failed to save to Vault/i.test(message)) return 'vault_save_failed'
  if (/required|Port must be|HOST_CONNECTION|HOST_DEFAULT_CONNECTION/i.test(message)) return 'validation_failed'
  return message ? 'unclassified_error' : 'none'
}

export async function setupTransferUi({driver:d,fixture:f,record}) {
  const password='Ui1'+randomBytes(24).toString('hex')
  await initializeOpsUiVault({driver:d,password,record})
  for(const h of Object.values(f.hosts)) {
    await main(d);await d.click('[data-tour="host-create"]');await d.waitFor(`dialog[open] ${id('host-form')}`)
    const fields={address:h.address,port:String(h.port),username:h.user,name:h.name}
    for(const [field,value] of Object.entries(fields))await d.fill(id(`host-${field}`),value,{keyboardClear:true})
    for(const [field,value] of Object.entries(fields))assert((await d.attr(id(`host-${field}`),'value'))===value,`transfer_ui_host_${field}_not_entered`)
    await d.click(id('host-auth-private-key'));const key=await readFile(h.privateKeyPath,'utf8');await d.fill(id('host-private-key'),key,{tabFrom:[id('host-auth-private-key'),id('host-auth-password')]})
    assert(String(await d.attr(id('host-private-key'),'value')).replaceAll('\r\n','\n')===key.replaceAll('\r\n','\n'),'transfer_ui_private_key_roundtrip_failed')
    await d.fill(id('host-secret-name'),`transfer-${h.role}-key`);assert(await d.attr(id('host-secret-name'),'value')===`transfer-${h.role}-key`,'transfer_ui_secret_reference_not_explicit')
    if(h.jump){await d.click(id('host-jump-toggle'));await d.select(id('host-jump-profile'),f.hosts[h.jump].id,{tabFrom:id('host-jump-toggle')})}
    await chooseServerMonitoring(d)
    record('transfer-host-form-ready',{role:h.role,fieldsMatched:true,privateKeyMatched:true,explicitReference:true})
    await d.click(id('host-save'));await closed(d,`dialog[open] ${id('host-form')}`)
    const saved=`${id('host-card')}[data-host-name=${q(h.name)}]`;await d.waitFor(saved);h.id=await d.attr(saved,'data-host-id');assert(h.id)
    await revealOpsUiHostActions(d, `${saved} ${id('host-connect')}`)
    await d.click(`${saved} ${id('host-connect')}`)
    await d.until(async()=>{
      const key=`dialog[open] ${id('host-key-confirm')}`
      if(await exists(d,key)) {
        const host=await d.attr(key,'data-host'),port=Number(await d.attr(key,'data-port'))
        const match=Object.values(f.hosts).find(x=>x.address===host&&x.port===port);assert(match)
        assert.equal(await d.attr(key,'data-code'),'host_key_unknown');assert.equal(normalFingerprint(await d.text(id('host-key-fingerprint'))),normalFingerprint(match.expectedFingerprint));await d.click(id('host-key-accept'));return false
      }
      const tab=`${id('pc-session-tab')}[data-host-id=${q(h.id)}]`
      if(await exists(d,tab)) assert.notEqual(await d.attr(tab,'data-status'),'error','transfer_ui_ssh_connection')
      return exists(d,`${id('terminal-session')}[data-host-id=${q(h.id)}][data-status="connected"]`)
    },{timeoutMs:90000})
    record('transfer-host-created',{role:h.role,credentialsSaved:true,fingerprintVerified:true,proxyJump:!!h.jump})
  }
  for(let i=0;i<f.servers.length;i++) {
    const server=f.servers[i]
    await main(d,'settings');await d.click(id('settings-category-monitoring'));await d.click(id('monitor-tab-services'))
    const root='//*[@data-testid="komari-settings"]'
    record('transfer-service-editor-opening',{service:i})
    await d.click(button(root,'Add monitoring service'));await d.fill('#komari-name',server.name);await d.fill('#komari-endpoint',server.endpoint)
    await d.click(`xpath=${root}//label[input[@type='radio' and @value='key']]`);await d.fill('#komari-api-key',server.apiKey)
    const enabled=`xpath=${root}//label[contains(.,'Enable monitoring connection')]/input[@type='checkbox']`
    if(!await d.isSelected(enabled))await d.click(enabled)
    record('transfer-service-saving',{service:i})
    await d.click(button(root,'Save connection'));await d.until(async()=>await d.attr('#komari-api-key','value')==='')
    record('transfer-service-saved',{service:i})
    await d.click(button(root,'Verify connection and discover nodes'))
    record('transfer-service-discovering',{service:i})
    for(const h of Object.values(f.hosts).filter(h=>h.service===i)) {
      const row=id(`komari-mapping-${h.node}`);await d.waitFor(row,{timeoutMs:60000});await d.select(`${row} select`,h.id)
      await d.click(button(`//*[@data-testid="komari-mapping-${h.node}"]`,'Save binding'))
      await d.until(async()=>!await d.isEnabled(button(`//*[@data-testid="komari-mapping-${h.node}"]`,'Save binding')))
    }
    record('transfer-service-mapped',{service:i,nodes:Object.values(f.hosts).filter(h=>h.service===i).length,credentialsSaved:true})
  }
  await main(d)
  return {password}
}

export async function openTransferTools(d,h) {
  await main(d)
  const toggle=`${card(h)} ${id('host-ops-details-toggle')}`
  // The host directory restores monitoring summaries asynchronously. Waiting
  // for their actual disclosure avoids permanently skipping a late summary.
  await d.waitFor(toggle,{timeoutMs:60000})
  if(await d.attr(toggle,'aria-expanded')==='false')await d.click(toggle)
  const tools=`${card(h)} ${id('compatible-agent-tools')}`
  await d.waitFor(tools,{timeoutMs:60000})
  if(await d.attr(tools,'open')===null)await d.click(`${tools} > summary`)
  await d.waitFor(panel(h))
}
async function openTransfer(d,h) {
  await openTransferTools(d,h)
  const root=transfer(h);await d.waitFor(root)
  if(await d.attr(root,'open')===null)await d.click(`${root} > summary`)
}
async function confirm(d,accept,names) {
  const root=`dialog[open] ${id('user-confirmation')}`;await d.waitFor(root,{timeoutMs:120000});assert.equal(await d.attr(root,'data-risk'),'high')
  const message=await d.text(id('user-confirmation-message'));for(const name of names)assert(message.includes(name),'transfer_ui_confirmation_scope')
  await d.click(id(`user-confirmation-${accept?'accept':'cancel'}`));await closed(d,root)
}
async function choose(d,f,source,target) {
  await openTransfer(d,source);const root=transfer(source)
  await d.click(`${root} ${id('probe-transfer-load')}`);const select=`${root} ${id('probe-transfer-target')}`;await d.waitFor(select)
  let value
  for(const option of await d.findAll(`${select} option`)){if((await d.text(option)).startsWith(target.name+' ·')){assert.equal(value,undefined);value=await d.attr(option,'value')}}
  assert(value!==undefined,'transfer_ui_target_missing');await d.select(select,value)
  await d.fill(`${root} ${id('probe-transfer-endpoint')}`,f.servers[target.service].agentEndpoint)
}
const observations=f=>Object.fromEntries(Object.values(f.hosts).map(h=>[h.role,f.observe(h)]))
const stable=async(f,before)=>{await delay(5000);assert.deepEqual(observations(f),before,'transfer_ui_unexpected_remote_replay')}
async function state(d,h,wanted) {await d.until(async()=>await d.attr(transfer(h),'data-status')===wanted,{timeoutMs:120000})}
async function audit(d,ids,statuses){
  await main(d,'activity');await d.click(id('audit-tab'));await d.click(id('operations-refresh'))
  const pending=new Map(ids.map((value,i)=>[value,statuses[i]]))
  for(let page=0;page<20;page++) {
    await d.until(async()=>await exists(d,id('operation-audit-row')) || await exists(d,id('audit-empty')))
    for(const row of await d.findAll(id('operation-audit-row'))) {
      const job=await d.attr(row,'data-job-id'),status=await d.attr(row,'data-status')
      if(pending.get(job)===status)pending.delete(job)
    }
    if(!pending.size)return
    if(!await d.isEnabled(id('operations-older')))break
    const before=await d.text(id('operations-page'));await d.click(id('operations-older'));await d.until(async()=>await d.text(id('operations-page'))!==before)
  }
  assert.equal(pending.size,0,'transfer_ui_audit_history_missing')
}
async function jobs(d,h){return [await d.attr(transfer(h),'data-job-id'),await d.attr(transfer(h),'data-target-job-id')]}
export async function revealTransferObservations(d,observations,anchor=observations){
  // Reveal the monitoring column through the existing visible range control.
  // A native WebKit click may scroll vertically while leaving this column
  // horizontally clipped. Navigation happens before the evidence frame.
  await revealOpsUiHostActions(d, observations)
  const viewport=await d.request('GET',d.route('/window/rect'))
  // Clicking a partially visible table can leave its edge clipped or under
  // the fixed header. Navigate via a nearby static caption, then verify the
  // full table. Choose direction only after horizontal navigation settles.
  let target = anchor
  if (typeof anchor !== 'string') {
    const { y } = await d.rect(anchor.above)
    assert(Number.isFinite(y), 'transfer_ui_caption_geometry_missing')
    target = y < 40 ? anchor.above : anchor.below
  }
  await d.click(target)
  // One real click only; subsequent paint checks are read-only. Both endpoint
  // rows must fit inside the window AND the list's horizontal clipping area.
  await d.until(async()=>{
    const box=await d.rect(observations)
    const list=await d.rect(id('host-list-scroll-viewport'))
    return box.width>0 && box.height>0 && box.y>=40 && box.y+box.height<=viewport.height
      && box.x>=Math.max(0,list.x) && box.x+box.width<=Math.min(viewport.width,list.x+list.width)
  },{timeoutMs:5000})
}
async function screenshot(d,h,name,checkpoint){
  await openTransfer(d,h)
  const observations=`${transfer(h)} ${id('probe-transfer-observations')}`
  await revealTransferObservations(d,observations,{above:`${transfer(h)} > div > p:first-child`,below:`${observations} + p`})
  for(const side of ['source','target'])assert((await d.text(`${transfer(h)} ${id(`probe-transfer-${side}-state`)}`)).trim())
  for(const field of await d.findAll('input[type="password"],textarea'))assert(!await d.attr(field,'value'),'transfer_ui_secret_on_screen')
  assert.equal((await d.findAll('iframe')).length,0)
  await checkpoint(name)
}

export async function runTransferUiJourney({driver,fixture:f,record,restart,checkpoint,state:session}) {
  let d=driver;const {source:a,target:b,restore:c,finish:e}=f.hosts;const auditHistory=[]
  await openTransferTools(d,a);await d.fill(`${panel(a)} ${id('compatible-agent-endpoint')}`,f.servers[a.service].agentEndpoint)
  const before=await f.sample(a),started=Date.now();await d.click(`${panel(a)} ${id('compatible-agent-install')}`);await confirm(d,true,[a.name,a.node]);await d.until(async()=>await d.attr(panel(a),'data-status')==='active',{timeoutMs:120000})
  const freshInstall=await f.fresh(a,before,started);record('transfer-app-install-verified',{...freshInstall,productionSignaturePath:true,noUserKeyConfiguration:true})
  const originalA=f.observe(a);assert.equal(originalA.length,1)
  await choose(d,f,a,b);const cancelled=observations(f);await d.click(`${transfer(a)} ${id('probe-transfer-move')}`);await confirm(d,false,[a.name,b.name,a.node,b.node]);await stable(f,cancelled)
  assert(!await d.attr(transfer(a),'data-transfer-id'));record('transfer-cancelled-without-remote-mutation',{passed:true,noReplayMs:5000})
  let mark=await f.sample(b),start=Date.now();await d.click(`${transfer(a)} ${id('probe-transfer-move')}`);await confirm(d,true,[a.name,b.name,a.node,b.node]);await state(d,a,'completed')
  const happyJobs=await jobs(d,a);assert(happyJobs.every(Boolean)&&new Set(happyJobs).size===2);auditHistory.push(...happyJobs.map(id=>[id,'completed']))
  assert.equal(f.observe(a)[0].processes.length,0);assert.equal(f.observe(a)[0].configSha256,originalA[0].configSha256)
  record('transfer-app-cross-service-machine-account-completed',{passed:true,...await f.fresh(b,mark,start),sourceStopped:true,sourceConfigurationRetained:true})
  await screenshot(d,a,'transfer-completed',checkpoint);await audit(d,happyJobs,['completed','completed'])
  for(const [target,action] of [[c,'restore'],[e,'finish']]) {
    await choose(d,f,b,target);const sourceBefore=f.observe(b);assert.equal(sourceBefore.filter(s=>s.processes.length).length,1)
    const release=f.hold(target);mark=await f.sample(target);start=Date.now()
    await d.click(`${transfer(b)} ${id('probe-transfer-move')}`);await confirm(d,true,[b.name,target.name,b.node,target.node])
    await wait(()=>f.servers[target.service].gate.held>0,120000)
    assert.equal(f.observe(b).filter(s=>s.processes.length).length,0);assert.equal(f.observe(target).filter(s=>s.processes.length).length,1)
    await target.history.capture()
    const interrupted=observations(f)
    // Kill only the isolated installed application while its real HTTP request
    // is pending; then restart the same profile and unlock via the visible UI.
    d=await restart(session.password);release();await stable(f,interrupted)
    await openTransfer(d,target);assert(['dispatched','unknown'].includes(await d.attr(transfer(target),'data-status')))
    const oldJobs=await jobs(d,target);assert(oldJobs.every(Boolean));record('transfer-interrupted-recovered-in-app',{action,passed:true,bothJobsRecovered:true,noReplayMs:5000})
    await d.click(`${transfer(target)} ${id('probe-transfer-inspect')}`);await state(d,target,'needs-recovery');await stable(f,interrupted)
    const inspectJobs=await jobs(d,target);assert(inspectJobs.every(id=>!oldJobs.includes(id)))
    auditHistory.push(...oldJobs.map(id=>[id,'unknown']),...inspectJobs.map(id=>[id,'completed']))
    await audit(d,oldJobs,['unknown','unknown']);await screenshot(d,target,`transfer-${action}-readback`,checkpoint)
    await d.click(`${transfer(target)} ${id(`probe-transfer-${action}`)}`);await confirm(d,false,[b.name,target.name]);await stable(f,interrupted)
    const recoveryHost=action==='restore'?b:target;mark=await f.sample(recoveryHost);start=Date.now()
    await d.click(`${transfer(target)} ${id(`probe-transfer-${action}`)}`);await confirm(d,true,[b.name,target.name]);await state(d,target,action==='restore'?'restored':'completed')
    const recoveredJobs=await jobs(d,target);auditHistory.push(...recoveredJobs.map(id=>[id,'completed']));assert(recoveredJobs.every(id=>!oldJobs.includes(id)&&!inspectJobs.includes(id)))
    assert.equal(f.observe(action==='restore'?target:b).filter(s=>s.processes.length).length,0)
    const fresh=await f.fresh(recoveryHost,mark,start);await f.retained()
    await openTransferTools(d,b);await d.until(async()=>await d.attr(panel(b),'data-status')===(action==='restore'?'active':'migrated'))
    await screenshot(d,target,`transfer-${action}-recovered`,checkpoint);await audit(d,recoveredJobs,['completed','completed'])
    record(`transfer-app-${action}-verified`,{passed:true,...fresh,twoHostAudit:true,priorAuditPreserved:true,cancelledRecoveryNoMutation:true})
  }
  assert.equal(auditHistory.length,14);assert.equal(new Set(auditHistory.map(([id])=>id)).size,14,'transfer_ui_duplicate_audit')
  const last=observations(f);d=await restart(session.password);await stable(f,last)
  await audit(d,auditHistory.map(x=>x[0]),auditHistory.map(x=>x[1]))
  record('transfer-app-audit-history-restored',{passed:true,auditJobs:auditHistory.length,jobs:auditHistory.map(([id,status])=>({id,status}))})
  await openTransferTools(d,e);await d.click(`${panel(e)} ${id('compatible-agent-uninstall')}`);await confirm(d,true,[e.name,e.node]);await d.until(async()=>await d.attr(panel(e),'data-status')==='retired',{timeoutMs:120000})
  assert(Object.values(f.hosts).every(h=>f.observe(h).every(s=>s.processes.length===0)))
  await f.retained();for(const h of Object.values(f.hosts))record('transfer-app-retained-history',{role:h.role,...await h.history.retained()});assert.equal(f.observe(a)[0].configSha256,originalA[0].configSha256)
  record('transfer-app-final-preservation-and-exit',{passed:true,auditJobs:auditHistory.length,allProbesStopped:true,originalConfigurationRetained:true,nodeCredentialsAndHistoryRetained:true,noReplayMs:5000})
  return {passed:true,installedPackage:true,productionIpc:true,realVault:true,normalMigration:1,interruptedMigrations:2,readonlyInspections:2,explicitRestore:1,explicitFinish:1,restoredAuditJobs:auditHistory.length,noReplayMs:5000}
}
