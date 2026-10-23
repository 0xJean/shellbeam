// Independent official-service observer and transport faults. No product IPC,
// App database writes, fake successful responses or frontend substitutes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { open, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'
import { downloadPinned } from './prepare-komari-agent-release.mjs'
import { freePort } from './run-ops-ui-live.mjs'
import { transferHistory } from './probe-transfer-history.mjs'

export async function bounded(read, timeout=60000) {
  const end=Date.now()+timeout
  while(Date.now()<end) { const result=await read();if(result)return result;await delay(100) }
  throw new Error('extension_ui_bounded_wait')
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const base='/api/admin/plugin', short='shellbeam-alerts'
const isMutation=(method,path)=>method==='POST' && (path.startsWith(base+'/') || path.startsWith('/api/admin/upload/'))

// The gate either withholds a request before dispatch or loses a response
// after the upstream commits. Bodies and credentials are never recorded.
export function extensionGateway(endpoint) {
  const trace=[], gate={mode:null,held:0}
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,endpoint).pathname
      trace.push({method:req.method,path});assert(trace.length<10000)
      assert(path.startsWith('/api/'),'extension_ui_web_frontend_requested')
      const chunks=[];let size=0
      for await(const chunk of req){size+=chunk.length;assert(size<4*1024*1024);chunks.push(chunk)}
      if(gate.mode==='before-delete' && path===base+'/delete' && req.method==='POST'){gate.held++;return}
      const headers={}
      for(const key of ['accept','authorization','content-type','origin','access-control-request-method','access-control-request-headers'])if(req.headers[key])headers[key]=req.headers[key]
      const response=await fetch(endpoint+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000)})
      const bytes=Buffer.from(await response.arrayBuffer())
      if(gate.mode==='after-merge' && path==='/api/admin/upload/merge' && req.method==='POST'){assert.equal(response.status,200);gate.held++;return}
      const output={}
      for(const key of ['content-type','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-allow-credentials','vary'])if(response.headers.has(key))output[key]=response.headers.get(key)
      res.writeHead(response.status,output);res.end(bytes)
    }catch{if(!res.headersSent)res.writeHead(502);res.end()}
  })
  return {server,trace,gate,mutations:()=>trace.filter(r=>isMutation(r.method,r.path)),arm(mode){assert(!gate.mode);assert(['before-delete','after-merge'].includes(mode));gate.mode=mode;gate.held=0},release(){gate.mode=null;server.closeAllConnections()}}
}

export async function createExtensionUiFixture({directory,project,record,binaryOverride}) {
  const architecture=process.arch==='arm64'?'arm64':'amd64'
  const pins=JSON.parse(await readFile(join(project,'scripts/fixtures/komari-lifecycle-releases.json')))
  const binary=join(directory,'official-komari'),services=[]
  const bytes=binaryOverride?await readFile(binaryOverride):await downloadPinned(`https://github.com/komari-monitor/komari/releases/download/${pins.server.version}/komari-linux-${architecture}`,pins.server[architecture],64*1024*1024)
  if(!binaryOverride)assert.equal(digest(bytes),pins.server[architecture].sha256)
  await writeFile(binary,bytes,{mode:0o700,flag:'wx'})
  const cleanup=async()=>{
    for(const s of services){s.gateway.release();await new Promise(resolve=>s.gateway.server.close(resolve));s.child.kill('SIGTERM');await bounded(()=>s.exited,10000);await s.log.close()}
    record('extension-fixture-cleaned',{serversStopped:true})
  }
  try {
    for(const role of ['fresh','legacy']) {
      const home=join(directory,role);await mkdir(home,{mode:0o700})
      const port=await freePort(),endpoint=`http://127.0.0.1:${port}`,apiKey=randomBytes(32).toString('hex')
      const log=await open(join(home,'server.log'),'wx',0o600)
      const child=spawn(binary,['server','--listen',`127.0.0.1:${port}`,'--database',join(home,'primary.db')],{cwd:home,env:{PATH:process.env.PATH,TZ:'UTC'},stdio:['ignore',log.fd,log.fd]})
      await writeFile(join(directory,role+'-pid'),String(child.pid),{mode:0o600,flag:'wx'})
      const gateway=extensionGateway(endpoint),service={role,name:`Extension UI ${role}`,apiKey,child,log,gateway,exited:false}
      services.push(service);child.once('exit',()=>{service.exited=true});child.once('error',()=>{service.exited=true})
      const request=async(path,body,headers={Authorization:`Bearer ${apiKey}`})=>{
        const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)})
        assert.equal(r.status,200,'extension_ui_official_http_status');const value=await r.json();assert.equal(value.error,undefined);return {value,data:value.data??value.result??value,response:r}
      }
      await bounded(async()=>{assert(!service.exited);try{return (await request('/api/install/status')).data.required===true}catch{return false}})
      const username='fixture',password='Sb1'+randomBytes(24).toString('hex')
      await request('/api/install/complete',{username,password,sitename:service.name,metric_dsn:join(home,'metrics.db')})
      await bounded(async()=>{try{return (await request('/api/version')).data.version==='1.6.0'}catch{return false}})
      const cookie=(await request('/api/login',{username,password})).response.headers.get('set-cookie')?.split(';')[0];assert(cookie)
      await request('/api/admin/settings',{api_key:apiKey,private_site:true,geo_ip_enabled:false,notification_enabled:false,eula_accepted:true},{Cookie:cookie,Origin:endpoint})
      const api=async(path,body)=>(await request(path,body)).data
      const node=await api('/api/admin/client/add',{name:`Extension preserved ${role}`})
      const original=(await api('/api/admin/client/list')).find(n=>n.uuid===node.uuid)
      const rpc=async method=>(await request('/api/rpc2',{jsonrpc:'2.0',id:1,method,params:{uuid:node.uuid}})).value.result
      await request('/api/clients/v2/rpc',{token:node.token,jsonrpc:'2.0',id:1,method:'agent.report',params:{report:{cpu:{usage:5},ram:{total:8192,used:4096},swap:{total:0,used:0},disk:{total:100000,used:20000},load:{load1:0.5,load5:0.3,load15:0.2},network:{up:1,down:1,totalUp:1,totalDown:1},connections:{tcp:2,udp:1},uptime:3600,process:5}}},{})
      const history=transferHistory(request,node.uuid,bounded);await history.capture()
      const upload=async archive=>{
        const init=await api('/api/admin/upload/init',{purpose:'plugin',filename:'fixture.zip',size:archive.length})
        const form=new FormData();form.append('upload_id',init.upload_id);form.append('chunk_index','0');form.append('chunk_data',new Blob([archive]),'fixture.zip')
        assert.equal((await fetch(endpoint+'/api/admin/upload/chunk',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form})).status,200)
        await api('/api/admin/upload/merge',{upload_id:init.upload_id})
      }
      if(role==='legacy') {
        const zip=new JSZip()
        for(const name of ['komari-plugin.json','policy.cjs','server.cjs'])zip.file(name,await readFile(join(project,'monitoring-extension/releases/0.1.0',name)))
        const state={version:1,identity:randomBytes(24).toString('hex'),revision:7,policy:{rules:[{id:'retained-rule',name:'Retained CPU',nodeId:node.uuid,nodeCreatedAt:original.created_at,metric:'cpu',threshold:80,recovery:50,durationSeconds:60,recoverySeconds:60,enabled:false}],silences:[{id:'retained-silence',name:'Retained maintenance',enabled:false,ruleIds:['retained-rule'],kind:'once',startAt:Date.now(),endAt:Date.now()+3600000}]},evaluations:{old:{sampledAt:123,notified:true}},events:[{delivery:'unknown',sampledAt:123}],receipts:[{revision:7}],future:{kept:true}}
        zip.file('state.json',JSON.stringify(state));await upload(await zip.generateAsync({type:'nodebuffer'}))
        await api(base+'/configuration',{short,data:{future:'preserved-configuration'}})
        await api(base+'/enabled',{short,enabled:true,approved:true})
      }
      const file=async name=>{const r=await fetch(`${endpoint}${base}/${short}/${name}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer())}
      const observe=async()=>{
        const row=(await api(base+'/list')).find(p=>p.short===short)
        if(!row)return {installed:false}
        const manifest=JSON.parse(await file('komari-plugin.json')),state=JSON.parse(await file('state.json'))
        const directory=manifest.version==='0.1.0'?'monitoring-extension/releases/0.1.0':'monitoring-extension'
        assert(['0.1.0','0.2.0'].includes(manifest.version))
        for(const name of ['komari-plugin.json','policy.cjs','server.cjs'])assert.deepEqual(await file(name),await readFile(join(project,directory,name)),'extension_ui_fixed_bytes')
        if(row.running && manifest.version==='0.2.0'){const runtime=await api('/api/shellbeam-alerts/v1/lifecycle');assert.equal(runtime.version,manifest.version);assert.equal(runtime.identity,state.identity)}
        return {installed:true,version:manifest.version,enabled:row.enabled,running:row.running,state,configuration:(await api(base+'/configuration?short='+short)).data}
      }
      const retained=async()=>{const current=(await api('/api/admin/client/list')).find(n=>n.uuid===node.uuid);for(const key of ['uuid','created_at','name'])assert.equal(current[key],original[key]);assert.equal((await rpc('admin:getClientToken')).token,node.token);return history.retained()}
      await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve))
      Object.assign(service,{endpoint:`http://127.0.0.1:${gateway.server.address().port}`,observe,retained,original:role==='legacy'?await observe():null})
    }
    record('extension-fixture-ready',{officialVersion:'1.6.0',architecture,services:2,pinnedServer:!binaryOverride})
    return {services,cleanup}
  }catch(e){await cleanup();throw e}
}
