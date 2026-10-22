// Disposable infrastructure and independent read-only observer. Product
// installs/moves/recovery are performed only through the packaged app UI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { downloadPinned } from './prepare-komari-agent-release.mjs'
import { verifyCompatibleCatalog } from './publish-komari-agent.mjs'

const command = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }).trim()
const docker = (...args) => command('docker', args)
export const wait = async (read, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await read(); if (result) return result; await delay(250) } throw new Error('transfer_ui_bounded_wait') }
const ready = async read => wait(async () => { try { return await read() } catch { return false } })
const latest = v => Array.isArray(v) ? Math.max(0, ...v.map(latest)) : !v || typeof v !== 'object' ? 0 : ['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some(k => k in v) ? Date.parse(v.time ?? v.updated_at ?? '') || 0 : Math.max(0, ...['records', 'reports', 'data', 'result'].map(k => latest(v[k])))
const observer = `import sys,json,pathlib,hashlib,os
q=json.load(sys.stdin); home=pathlib.Path('/root' if q['user']=='root' else '/home/probe'); base=home/'.local/share/shellbeam/komari'; out=[]
for root in base.glob('*'):
 try:
  raw=(root/'config.json').read_bytes(); config=json.loads(raw)
  if config.get('token')!=q['token']: continue
  stateRaw=(root/'state.json').read_bytes(); state=json.loads(stateRaw); procs=[]
  for proc in pathlib.Path('/proc').glob('[0-9]*'):
   try:
    exe=os.readlink(proc/'exe')
    if not exe.startswith(str(root)+'/'): continue
    procs.append(dict(pid=int(proc.name),start=(proc/'stat').read_text().split(') ')[1].split()[19],sha256=hashlib.sha256((proc/'exe').read_bytes()).hexdigest()))
   except (OSError,ValueError): pass
  out.append(dict(deployment=root.name,status=state['status'],receipt=state.get('transfer'),stateSha256=hashlib.sha256(stateRaw).hexdigest(),configSha256=hashlib.sha256(raw).hexdigest(),processes=procs,version=(state.get('current') or {}).get('version')))
 except FileNotFoundError: pass
print(json.dumps(sorted(out,key=lambda r:r['deployment'])))`

export async function createTransferUiFixture({ directory, project, prefix, record }) {
  assert(/^sb-ui-transfer-[a-f0-9]{12}$/.test(prefix))
  const network = prefix + '-net', machines = [prefix + '-a', prefix + '-b'], gateways = [], servers = [], hosts = {}
  let stopped = false
  const cleanup = async () => {
    if (stopped) return; stopped = true
    for (const g of gateways) { g.server.closeAllConnections(); await new Promise(resolve => g.server.close(resolve)) }
    for (const name of machines) {
      const names=docker('ps','-a','--format','{{.Names}}').split('\n')
      if(names.includes(name)) { assert.equal(docker('inspect','-f','{{index .Config.Labels "shellbeam.ui-owner"}}',name),prefix); docker('rm','-f',name) }
    }
    if(docker('network','ls','--format','{{.Name}}').split('\n').includes(network)) { assert.equal(docker('network','inspect','-f','{{index .Labels "shellbeam.ui-owner"}}',network),prefix);docker('network','rm',network) }
    assert(!docker('ps','-a','--format','{{.Names}}').split('\n').some(n=>machines.includes(n)))
    assert(!docker('network','ls','--format','{{.Name}}').split('\n').includes(network))
    record('transfer-fixture-cleaned', { containersRemoved: true, networkRemoved: true, serversStopped: true })
  }
  try {
    docker('network', 'create', '--label', `shellbeam.ui-owner=${prefix}`, network)
    for (const name of machines) {
      docker('run', '-d', '--name', name, '--hostname', name, '--label', `shellbeam.ui-owner=${prefix}`, '--network', network, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--memory', '768m', '--cpus', '1', '--pids-limit', '512', '-p', '127.0.0.1::22', '-p', '127.0.0.1::25700', 'shellbeam-probe-transfer-fixture:ci')
      await ready(() => docker('exec', name, 'systemctl', 'is-active', 'ssh') === 'active')
      const uid=docker('exec',name,'id','-u','probe'); docker('exec',name,'loginctl','enable-linger','probe'); docker('exec',name,'systemctl','start',`user@${uid}.service`)
    }
    assert.notEqual(docker('exec',machines[0],'cat','/etc/machine-id'),docker('exec',machines[1],'cat','/etc/machine-id'))
    const key=join(directory,'fixture-key'); command('ssh-keygen',['-q','-t','rsa','-b','2048','-m','PEM','-N','','-f',key]); const publicKey=await readFile(key+'.pub')
    for(const name of machines) {
      docker('exec',name,'mkdir','-p','/root/.ssh','/home/probe/.ssh','/opt/fixture')
      for(const path of ['/root/.ssh/authorized_keys','/home/probe/.ssh/authorized_keys']) command('docker',['exec','-i',name,'tee',path],publicKey)
      command('docker',['exec','-i',name,'tee','/etc/ssh/sshd_config.d/hostkey.conf'],'HostKey /etc/ssh/ssh_host_ed25519_key\n'); docker('exec',name,'systemctl','restart','ssh')
      docker('exec',name,'chown','-R','probe:probe','/home/probe/.ssh'); docker('exec',name,'chmod','700','/root/.ssh','/home/probe/.ssh')
    }
    const fingerprints=machines.map(name=>{ const publicKey=docker('exec',name,'cat','/etc/ssh/ssh_host_ed25519_key.pub').split(' ')[1]; return 'SHA256:'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('base64') })
    const ports=machines.map(name=>Number(docker('port',name,'22').split(':').at(-1)))
    const targetIP=docker('inspect','-f','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',machines[1])
    const apiPorts=machines.map(name=>Number(docker('port',name,'25700').split(':').at(-1)))
    const pins=JSON.parse(await readFile(join(project,'scripts/fixtures/komari-lifecycle-releases.json')))
    const architecture=docker('exec',machines[0],'uname','-m')==='aarch64'?'arm64':'amd64'
    const trust=JSON.parse(await readFile(join(project,'src-tauri/src/data/komari_agent/official-trust.json')))
    const catalog=verifyCompatibleCatalog(JSON.parse(await downloadPinned(trust.catalogUrl,null,65536)),trust)
    const release=catalog.artifacts.find(a=>a.architecture===architecture); assert(release)
    assert.equal(release.sha256,pins.agents.find(a=>a.version===release.version)[architecture].sha256)
    const serverFile=join(directory,'server'); await writeFile(serverFile,await downloadPinned(`https://github.com/komari-monitor/komari/releases/download/${pins.server.version}/komari-linux-${architecture}`,pins.server[architecture],64*1024*1024),{mode:0o700})
    for(let index=0;index<2;index++) {
      const name=machines[index], endpoint=`http://127.0.0.1:${apiPorts[index]}`, agentEndpoint=`http://${name}:25700`, apiKey=randomBytes(32).toString('hex')
      docker('cp',serverFile,name+':/opt/fixture/server'); docker('exec','-d',name,'/opt/fixture/server','server','--listen','0.0.0.0:25700','--database','/opt/fixture/primary.db')
      const request=async (path,body,headers={Authorization:`Bearer ${apiKey}`})=>{ const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}); assert.equal(r.status,200); const v=await r.json(); return {response:r,value:v,data:v.data??v.result??v} }
      await ready(async ()=>(await request('/api/install/status')).data.required===true)
      const username='fixture',password='Sb1'+randomBytes(24).toString('hex')
      await request('/api/install/complete',{username,password,sitename:'Transfer UI fixture',metric_dsn:'/opt/fixture/metrics.db'})
      await ready(async ()=>(await request('/api/version')).data.version==='1.6.0')
      const cookie=(await request('/api/login',{username,password})).response.headers.get('set-cookie')?.split(';')[0]; assert(cookie)
      await request('/api/admin/settings',{api_key:apiKey,private_site:true,geo_ip_enabled:false,notification_enabled:false,eula_accepted:true},{Cookie:cookie,Origin:endpoint})
      const gate={node:null,held:0,server:null}
      gate.server=createServer(async (req,res)=>{ try {
        // Fault only at the real HTTP transport: never fabricate a successful
        // sample or modify response bytes. The request remains pending until
        // app exit (or its normal timeout). All other calls go to upstream.
        if(gate.node && req.url===`/api/recent/${gate.node}`) {
          const h=Object.values(hosts).find(h=>h.node===gate.node)
          if(h && observe(h).some(s=>s.processes.length>0)) { gate.held++; return }
        }
        const chunks=[]; for await(const chunk of req) chunks.push(chunk)
        const response=await fetch(endpoint+req.url,{method:req.method,headers:{'Content-Type':'application/json',...(req.headers.authorization?{Authorization:req.headers.authorization}:{})},...(chunks.length?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000)})
        res.writeHead(response.status,{'Content-Type':'application/json'}); res.end(Buffer.from(await response.arrayBuffer()))
      } catch { res.writeHead(502);res.end() } })
      await new Promise(resolve=>gate.server.listen(0,'127.0.0.1',resolve)); gateways.push(gate)
      servers.push({name:`UI monitoring ${index}`,apiKey,endpoint:`http://127.0.0.1:${gate.server.address().port}`,agentEndpoint,request,gate})
    }
    const specs=[['source',0,'root',0],['target',1,'probe',1],['restore',1,'root',1],['finish',0,'root',1]]
    for(const [role,machine,user,service] of specs) {
      const server=servers[service]; const node=(await server.request('/api/admin/client/add',{name:`UI migration ${role}`})).data
      const rpc=async method=>(await server.request('/api/rpc2',{jsonrpc:'2.0',id:1,method,params:{uuid:node.uuid}})).value.result
      hosts[role]={role,name:`UI migration ${role}`,machine,user,service,address:machine===1?targetIP:'127.0.0.1',port:machine===1?22:ports[machine],privateKeyPath:key,expectedFingerprint:fingerprints[machine],node:node.uuid,token:node.token,rpc,original:await rpc('admin:getClient'),...(machine===1?{jump:'source'}:{})}
    }
    const allKeys=new Set(Object.values(hosts).map(h=>h.token)); assert.equal(allKeys.size,4)
    record('transfer-fixture-ready',{machineIdentitiesDistinct:true,architecture,services:2,hosts:4,productionKeyId:trust.keyId,sequence:catalog.sequence,version:release.version})
    function observe(h) { return JSON.parse(command('docker',['exec','-i',machines[h.machine],'python3','-c',observer],JSON.stringify({user:h.user,token:h.token}))) }
    const sample=async h=>latest((await servers[h.service].request(`/api/recent/${h.node}`)).value)
    const fresh=async(h,before,started)=>wait(async()=>{const time=await sample(h);const observations=observe(h);const active=observations.filter(s=>s.processes.length===1); if(!(time>before && time>=started-5000 && time>=Date.now()-60000 && active.length===1))return false; assert(time<=Date.now()+5000);const s=active[0]; assert.equal(s.processes[0].sha256,release.sha256);assert.equal(s.version,release.version);const node=await h.rpc('admin:getClient');assert.equal(node.created_at,h.original.created_at);assert.equal(node.uuid,h.node);return {originalSampleAt:time,before,started,verifiedAt:Date.now(),processSha256:s.processes[0].sha256} })
    const retained=async()=>{for(const h of Object.values(hosts)){assert.equal((await h.rpc('admin:getClientToken')).token,h.token);assert.equal((await h.rpc('admin:getClient')).created_at,h.original.created_at)}}
    const hold=h=>{const gate=servers[h.service].gate;assert(!gate.node);gate.node=h.node;gate.held=0;return()=>{gate.node=null;gate.server.closeAllConnections()}}
    await rm(serverFile)
    return {hosts,servers,release,observe,sample,fresh,retained,hold,cleanup,architecture}
  } catch(e) {await cleanup();throw e}
}
