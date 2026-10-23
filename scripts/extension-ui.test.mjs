import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { extensionGateway, bounded } from './extension-ui-fixture.mjs'
import { assertPreserved, revealExtensionAudit } from './extension-ui-journey.mjs'
import { verifyExtensionUiReport } from './extension-ui-report.mjs'

test('fault transport holds deletion before upstream and loses merge response only after commit',async()=>{
  const seen=[];const upstream=createServer((req,res)=>{seen.push(req.url);res.setHeader('Access-Control-Allow-Origin','tauri://localhost');res.end('{"status":"success"}')})
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const g=extensionGateway(`http://127.0.0.1:${upstream.address().port}`)
  await new Promise(r=>g.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${g.server.address().port}`
  try {
    const r=await fetch(url+'/api/version',{headers:{Origin:'tauri://localhost'}});assert.equal(r.headers.get('access-control-allow-origin'),'tauri://localhost');assert.equal(await r.text(),'{"status":"success"}')
    for(const [mode,path,forwarded] of [['before-delete','/api/admin/plugin/delete',false],['after-merge','/api/admin/upload/merge',true]]) {
      g.arm(mode);let settled=false
      const pending=fetch(url+path,{method:'POST',body:'{"secret":"synthetic-fixture"}',headers:{Authorization:'Bearer synthetic-secret'},signal:AbortSignal.timeout(5000)}).catch(()=>null).finally(()=>{settled=true})
      await bounded(()=>g.gate.held===1);assert.equal(seen.includes(path),forwarded);assert.equal(settled,false)
      g.release();await pending
    }
    assert(!JSON.stringify(g.trace).includes('synthetic'));assert(g.trace.every(r=>Object.keys(r).sort().join(',')==='method,path'))
    assert.equal(g.mutations().length,2)
  }finally{for(const server of [g.server,upstream]){server.closeAllConnections();await new Promise(r=>server.close(r))}}
})

const original={installed:true,enabled:true,running:true,version:'0.1.0',state:{identity:'i',revision:7,policy:{rules:[{}],silences:[{}]},events:[{delivery:'unknown'}],receipts:[{revision:7}],evaluations:{old:{notified:true}},future:{retained:true}},configuration:{future:true}}
test('preservation proof rejects lost state, receipts, dispatch markers and configuration',()=>{
  assertPreserved({...original,version:'0.2.0'},original,'0.2.0')
  for(const key of ['identity','revision','policy','events','receipts','future','evaluations']){const next=structuredClone(original);next.state[key]=null;assert.throws(()=>assertPreserved(next,original,'0.1.0'))}
  assert.throws(()=>assertPreserved({...original,configuration:{}},original,'0.1.0'))
})

function report() {
  const jobs=Array.from({length:13},(_,i)=>({id:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,status:i<3?'unknown':'completed',action:['monitoring.service.update','monitoring.extension.upgrade','monitoring.extension.uninstall','monitoring.extension.restore'][i%4]}))
  return {success:true,cleanup:true,applicationStopped:true,headCommit:'a'.repeat(40),checkedOutCommit:'b'.repeat(40),journey:{passed:true,installedPackage:true,productionIpc:true,realVault:true,nativeShellBeamPages:true,install:1,uninstall:1,restore:2,interrupted:2,upgrade:1,conflict:1,noReplayMs:5000,auditJobs:jobs.length},events:[
    {name:'extension-fixture-ready',officialVersion:'1.6.0',pinnedServer:true,services:2},
    {name:'extension-cancelled-without-mutation',passed:true},
    {name:'extension-app-installed',version:'0.2.0',fixedBytes:true,explicitConfirmation:true},
    {name:'extension-app-uninstalled',backupRetained:true,explicitConfirmation:true},
    {name:'extension-app-restored-after-restart',originalIdentity:true,encryptedBackupReopened:true,noReplayMs:5000},
    {name:'extension-app-upgrade-recovered',originalVersion:'0.1.0',version:'0.2.0',responseLost:true,unknownJobRetained:true,noDuplicateMerge:true,stateAndConfigurationRetained:true,unknownDispatchRetained:true,noReplayMs:5000},
    {name:'extension-app-interrupted-removal-restored',backupBeforeDelete:true,originalIdentity:true,unknownDispatchRetained:true,explicitRestore:true,noReplayMs:5000},
    {name:'extension-app-conflict-preserved',runningStateNotOverwritten:true,backupRetained:true},
    ...['fresh','legacy'].map(role=>({name:'extension-retained-node-history',role,credentialStillWorks:true,originalBuckets:[1000],checkedAt:2000,retainedBuckets:1})),
    {name:'extension-app-audit-restored',oneVault:true,auditRowVisible:true,auditRowStatus:'completed',credentialRecordsUnchanged:true,encryptedIntents:8,jobs},
    {name:'extension-fixture-cleaned',serversStopped:true}],screenshots:['installed','uninstalled','restored','upgrade-recovered','removal-recovered','audit'].map(n=>({file:`extension-${n}.png`,sha256:'c'.repeat(64),bytes:10000,width:1280,height:900}))}
}
test('complete report contract accepts all lifecycle and evidence fields',()=>assert(verifyExtensionUiReport(report())))
for(const [name,change] of [
  ['audit row offscreen',r=>r.events[10].auditRowVisible=false],['no app coordinator',r=>r.journey.productionIpc=false],['web frontend',r=>r.journey.nativeShellBeamPages=false],['no vault',r=>r.journey.realVault=false],['incomplete cleanup',r=>r.cleanup=false],['app still running',r=>r.applicationStopped=false],['no interruption',r=>r.journey.interrupted=0],['short no replay',r=>r.journey.noReplayMs=1],['untrusted server',r=>r.events[0].pinnedServer=false],['repeated merge',r=>r.events[5].noDuplicateMerge=false],['lost unknown dispatch',r=>r.events[5].unknownDispatchRetained=false],['deleted before backup',r=>r.events[6].backupBeforeDelete=false],['overwritten conflict',r=>r.events[7].runningStateNotOverwritten=false],['lost history',r=>r.events[8].originalBuckets=[]],['missing credential',r=>r.events[8].credentialStillWorks=false],['rewritten audit',r=>r.events[10].jobs[0].status='completed'],['duplicate audit',r=>r.events[10].jobs[1]=r.events[10].jobs[0]],['missing screenshots',r=>r.screenshots.pop()],['missing encryption',r=>r.events[10].encryptedIntents=0],
])test(`report gate rejects ${name}`,()=>{const r=report();change(r);assert.throws(()=>verifyExtensionUiReport(r))})
test('ordinary desktop launch refused before any fixture is created',()=>{
  const result=spawnSync('bash',['scripts/ci-extension-ui.sh'],{env:{PATH:process.env.PATH,GITHUB_ACTIONS:'false'},encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stdout,/requires opt-in/)
})
test('bounded inspection never implicitly retries a mutation',async()=>{
  let reads=0;await assert.rejects(bounded(async()=>{reads++;await delay(1);return false},10),/bounded_wait/);assert(reads>0)
})


test('audit screenshot reveals one inert row and waits for complete viewport visibility',async()=>{
  let clicks=0,reads=0
  const d={click:async()=>{clicks++},rect:async()=>({x:200,y:reads++?400:1000,width:1000,height:120}),elementRoute:async(_,p)=>p,request:async(_,p)=>p.endsWith('Width')?1280:800,attr:async()=> 'completed',until:async read=>{assert.equal(await read(),false);assert.equal(await read(),true)}}
  assert.deepEqual(await revealExtensionAudit(d),{auditRowVisible:true,auditRowStatus:'completed'});assert.equal(clicks,1)
  d.rect=async()=>({x:1200,y:100,width:300,height:50});d.until=async read=>{assert.equal(await read(),false);throw Error('viewport_not_ready')}
  await assert.rejects(revealExtensionAudit(d),/viewport_not_ready/);assert.equal(clicks,2)
})
