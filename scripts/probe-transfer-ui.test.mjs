import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { forwardTransferRequest } from './probe-transfer-ui-fixture.mjs'
import { verifyTransferUiReport } from './probe-transfer-ui-report.mjs'
import { historyTimes, transferHistory } from './probe-transfer-history.mjs'
import { guardUiEnvironment } from './run-ops-ui-live.mjs'
const report=()=>({success:true,applicationStopped:true,cleanup:true,headCommit:'a'.repeat(40),checkedOutCommit:'b'.repeat(40),journey:{passed:true,installedPackage:true,productionIpc:true,realVault:true,normalMigration:1,interruptedMigrations:2,readonlyInspections:2,explicitRestore:1,explicitFinish:1,restoredAuditJobs:14,noReplayMs:5000},screenshots:['completed','restore-readback','restore-recovered','finish-readback','finish-recovered'].map(n=>({file:`transfer-${n}.png`,sha256:'c'.repeat(64),bytes:10000,width:1280,height:900})),events:[{name:'transfer-fixture-ready',machineIdentitiesDistinct:true,architecture:'amd64',services:2,hosts:4,productionKeyId:'compatible-probe-2026-01',sequence:1792594908584},...['transfer-app-install-verified','transfer-app-cross-service-machine-account-completed','transfer-app-restore-verified','transfer-app-finish-verified'].map(name=>({name,originalSampleAt:12000,before:11000,started:11500,verifiedAt:12500,processSha256:'d'.repeat(64)})),{name:'transfer-cancelled-without-remote-mutation',passed:true},...['restore','finish'].map(action=>({name:'transfer-interrupted-recovered-in-app',action,passed:true,bothJobsRecovered:true,noReplayMs:5000})),{name:'transfer-app-audit-history-restored',passed:true,auditJobs:14},...['source','target','restore','finish'].map(role=>({name:'transfer-app-retained-history',role,originalBuckets:[60000],retainedBuckets:1,checkedAt:120000})),{name:'transfer-app-final-preservation-and-exit',passed:true,allProbesStopped:true,auditJobs:14,originalConfigurationRetained:true,nodeCredentialsAndHistoryRetained:true}]})
test('report gate accepts a complete synthetic contract example',()=>assert(verifyTransferUiReport(report())))
for(const [name,change] of [
 ['missing persisted history',r=>{r.events=r.events.filter(e=>e.name!=='transfer-app-retained-history')}],['invalid retained bucket',r=>{r.events.find(e=>e.name==='transfer-app-retained-history').originalBuckets=[0]}],['incomplete cleanup',r=>{r.cleanup=false}],['application still running',r=>{r.applicationStopped=false}],['old cached observation',r=>{r.events[1].originalSampleAt=r.events[1].before}],['missing destination audit',r=>{r.journey.restoredAuditJobs=7}],['missing restore',r=>{r.journey.explicitRestore=0}],['missing real Vault',r=>{r.journey.realVault=false}],['missing receipt inspection',r=>{r.journey.readonlyInspections=0}],['missing no-replay window',r=>{r.journey.noReplayMs=0}],['duplicate screenshot',r=>{r.screenshots[1]=r.screenshots[0]}],['same machine disguised as migration',r=>{r.events[0].machineIdentitiesDistinct=false}],['lost configuration',r=>{r.events.at(-1).originalConfigurationRetained=false}],
])test(`report gate rejects ${name}`,()=>{const r=report();change(r);assert.throws(()=>verifyTransferUiReport(r))})
test('shell refuses an ordinary desktop before creating any fixture',()=>{const r=spawnSync('bash',['scripts/ci-probe-transfer-ui.sh'],{env:{PATH:process.env.PATH,GITHUB_ACTIONS:'false'},encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stdout,/requires opt-in/)})
test('native UI runner refuses root and self-hosted environments',()=>{assert.throws(()=>guardUiEnvironment({},'linux',0));assert.throws(()=>guardUiEnvironment({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted'},'linux',1000))})
test('fault gateway preserves real CORS preflight, authorization and response bytes',async()=>{
  const seen=[];const origin='http://tauri.localhost',body=Buffer.from('[{"uuid":"fixture-node"}]\n')
  const upstream=createServer((req,res)=>{
    seen.push({method:req.method,origin:req.headers.origin,headers:req.headers['access-control-request-headers'],authorization:req.headers.authorization})
    res.writeHead(req.method==='OPTIONS'?204:200,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization','Vary':'Origin','Content-Type':'application/json'});res.end(req.method==='OPTIONS'?undefined:body)
  })
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
  const endpoint=await listen(upstream),gateway=createServer((req,res)=>void forwardTransferRequest(req,res,endpoint))
  try{
    const url=await listen(gateway)
    const preflight=await fetch(url+'/api/admin/client/list',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}})
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(preflight.headers.get('access-control-allow-headers'),'Authorization');assert.equal(preflight.headers.get('vary'),'Origin')
    const response=await fetch(url+'/api/admin/client/list',{headers:{Origin:origin,Authorization:'Bearer synthetic-fixture'}})
    assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.deepEqual(Buffer.from(await response.arrayBuffer()),body)
    assert.deepEqual(seen,[{method:'OPTIONS',origin,headers:'authorization',authorization:undefined},{method:'GET',origin,headers:undefined,authorization:'Bearer synthetic-fixture'}])
  }finally{for(const server of [gateway,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
})

test('history proof preserves original metric-store buckets across recent-cache expiry',async()=>{
  const paths=[];let response={data:{records:[{client:'node',cpu:0,time:'2026-10-22T05:00:00Z'}]}}
  const history=transferHistory(async path=>{paths.push(path);return {value:response}},'node',async read=>{const value=await read();assert(value);return value})
  const baseline=await history.capture();response.data.records.push({client:'node',cpu:12,time:'2026-10-22T05:01:00Z'})
  const retained=await history.retained();assert.deepEqual(retained.originalBuckets,baseline);assert.equal(retained.retainedBuckets,2)
  assert(paths.every(p=>p==='/api/records/load?uuid=node&load_type=all&hours=1'))
  response={data:{records:[{client:'node',cpu:12,time:'2026-10-22T05:01:00Z'}]}}
  await assert.rejects(history.retained(),/transfer_history_original_bucket_missing/)
})
test('history proof rejects another node, missing original times and uncaptured history',async()=>{
  assert.throws(()=>historyTimes({data:{records:[{client:'other',cpu:1,time:'2026-10-22T05:00:00Z'}]}},'node'),/node_mismatch/)
  assert.throws(()=>historyTimes({client:'node',cpu:1},'node'),/original_time_missing/)
  await assert.rejects(transferHistory(async()=>({value:{}}),'node',async()=>false).retained(),/baseline_missing/)
})
