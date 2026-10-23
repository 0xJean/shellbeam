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
import { transferHistory } from './probe-transfer-history.mjs'
import { verifyServerIdentity, serverIdentity } from './monitoring-agent-ui-evidence.mjs'

const command = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }).trim()
const docker = (...args) => command('docker', args)
export const wait = async (read, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await read(); if (result) return result; await delay(250) } throw new Error('transfer_ui_bounded_wait') }
const ready = async read => wait(async () => { try { return await read() } catch { return false } })
// Keep the real server's CORS contract across the fault-injection transport.
// The WebView performs preflights; a Node-only client would miss this boundary.
export async function forwardTransferRequest(req,res,endpoint) {
  const headers={}
  for(const name of ['accept','authorization','content-type','origin','access-control-request-method','access-control-request-headers'])if(req.headers[name])headers[name]=req.headers[name]
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const response=await fetch(endpoint+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000)})
  const responseHeaders={}
  for(const name of ['content-type','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-allow-credentials','access-control-expose-headers','access-control-max-age','vary'])if(response.headers.has(name))responseHeaders[name]=response.headers.get(name)
  res.writeHead(response.status,responseHeaders);res.end(Buffer.from(await response.arrayBuffer()))
}
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

export async function createTransferUiFixture({ directory, project, prefix, record, monitoringAgentServer, topology = 'transfer' }) {
  assert(monitoringAgentServer, 'transfer_ui_shellbeam_server_required')
  assert(['agent', 'transfer'].includes(topology))
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
    const architecture=docker('exec',machines[0],'uname','-m')==='aarch64'?'arm64':'amd64'
    const trust=JSON.parse(await readFile(join(project,'src-tauri/src/data/komari_agent/official-trust.json')))
    const catalog=verifyCompatibleCatalog(JSON.parse(await downloadPinned(trust.catalogUrl,null,65536)),trust)
    const release=catalog.artifacts.find(a=>a.architecture===architecture); assert(release)
    const reviewed=JSON.parse(await readFile(join(project,'releases/compatible-probe-pins.json'))).versions[release.version]?.[architecture]
    assert(reviewed);assert.equal(release.sha256,reviewed.sha256);assert.equal(release.sizeBytes,reviewed.size)
    const serverFile=join(directory,'server'); await writeFile(serverFile,await readFile(monitoringAgentServer),{mode:0o700})
    for(let index=0;index<2;index++) {
      const name=machines[index], endpoint=`http://127.0.0.1:${apiPorts[index]}`, agentEndpoint=`http://${name}:25700`, apiKey=randomBytes(32).toString('hex')
      docker('cp',serverFile,name+':/opt/fixture/server'); docker('exec','-d',name,'/opt/fixture/server','server','--listen','0.0.0.0:25700','--database','/opt/fixture/primary.db')
      const request=async (path,body,headers={Authorization:`Bearer ${apiKey}`})=>{ const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}); assert.equal(r.status,200); const v=await r.json(); return {response:r,value:v,data:v.data??v.result??v} }
      await ready(async ()=>(await request('/api/install/status')).data.required===true)
      verifyServerIdentity((await request('/api/version', undefined, {})).data)
      const username='fixture',password='Sb1'+randomBytes(24).toString('hex')
      await request('/api/install/complete',{username,password,sitename:'Transfer UI fixture',metric_dsn:'/opt/fixture/metrics.db'})
      await ready(async ()=>(await request('/api/me', undefined, {})).response.status===200)
      verifyServerIdentity((await request('/api/version', undefined, {})).data);record('agent-server-identity-verified',{service:index,commit:serverIdentity.hash,product:serverIdentity.product,preInstallIdentityVerified:true,binarySha256:createHash('sha256').update(await readFile(serverFile)).digest('hex')})
      const cookie=(await request('/api/login',{username,password})).response.headers.get('set-cookie')?.split(';')[0]; assert(cookie)
      await request('/api/admin/settings',{api_key:apiKey,private_site:true,geo_ip_enabled:false,notification_enabled:false,eula_accepted:true},{Cookie:cookie,Origin:endpoint})
      const gate={node:null,held:0,server:null}
      gate.server=createServer(async (req,res)=>{ try {
        // Fault only at the real HTTP transport: never fabricate a successful
        // sample or modify response bytes. The request remains pending until
        // app exit (or its normal timeout). All other calls go to upstream.
        if(gate.node && req.url===`/api/recent/${gate.node}`) {
          const h=Object.values(hosts).find(h=>h.node===gate.node)
          if(h && observe(h).some(s=>s.processes.length>0 && (!gate.version || s.version===gate.version))) { gate.held++; return }
        }
        await forwardTransferRequest(req,res,endpoint)
      } catch { res.writeHead(502);res.end() } })
      await new Promise(resolve=>gate.server.listen(0,'127.0.0.1',resolve)); gateways.push(gate)
      servers.push({name:`UI monitoring ${index}`,apiKey,endpoint:`http://127.0.0.1:${gate.server.address().port}`,agentEndpoint,request,gate})
    }
    const specs=[['source',0,'root',0],['target',1,'probe',1],['restore',1,'root',1],['finish',0,'root',1]]
    for(const [role,machine,user,service] of (topology==='agent'?specs.slice(0,2):specs)) {
      const server=servers[service]; const node=(await server.request('/api/admin/client/add',{name:`UI migration ${role}`})).data
      const rpc=async method=>(await server.request('/api/rpc2',{jsonrpc:'2.0',id:1,method,params:{uuid:node.uuid}})).value.result
      hosts[role]={history:transferHistory(server.request,node.uuid,wait),role,name:`UI migration ${role}`,machine,user,service,address:machine===1?targetIP:'127.0.0.1',port:machine===1?22:ports[machine],privateKeyPath:key,expectedFingerprint:fingerprints[machine],node:node.uuid,token:node.token,rpc,original:await rpc('admin:getClient'),...(machine===1?{jump:'source'}:{})}
    }
    const allKeys=new Set(Object.values(hosts).map(h=>h.token)); assert.equal(allKeys.size,topology==='agent'?2:4)
    record('transfer-fixture-ready',{machineIdentitiesDistinct:true,architecture,services:2,hosts:Object.keys(hosts).length,productionKeyId:trust.keyId,sequence:catalog.sequence,version:release.version})
    function observe(h) { return JSON.parse(command('docker',['exec','-i',machines[h.machine],'python3','-c',observer],JSON.stringify({user:h.user,token:h.token}))) }
    const sample=async h=>latest((await servers[h.service].request(`/api/recent/${h.node}`)).value)
    const fresh=async(h,before,started)=>{const evidence=await wait(async()=>{const time=await sample(h);const observations=observe(h);const active=observations.filter(s=>s.processes.length===1); if(!(time>before && time>=started-5000 && time>=Date.now()-60000 && active.length===1))return false; assert(time<=Date.now()+5000);const s=active[0]; assert.equal(s.processes[0].sha256,release.sha256);assert.equal(s.version,release.version);const node=await h.rpc('admin:getClient');assert.equal(node.created_at,h.original.created_at);assert.equal(node.uuid,h.node);return {originalSampleAt:time,before,started,verifiedAt:Date.now(),processSha256:s.processes[0].sha256} });await h.history.capture();return evidence}
    const retained=async()=>{for(const h of Object.values(hosts)){assert.equal((await h.rpc('admin:getClientToken')).token,h.token);assert.equal((await h.rpc('admin:getClient')).created_at,h.original.created_at)}}
    const hold=(h,version)=>{const gate=servers[h.service].gate;assert(!gate.node);gate.node=h.node;gate.version=version;gate.held=0;return()=>{gate.node=null;gate.version=null;gate.server.closeAllConnections()}}
    // Provision a genuine unmanaged historical service as migration input.
    // No application database or managed deployment is manufactured here.
    const prepareLegacy = async (h, manifest) => {
      assert.equal(topology, 'agent');assert.equal(manifest.version, '1.5.11')
      const pin=JSON.parse(await readFile(join(project,'releases/compatible-probe-pins.json'))).versions['1.5.11'][architecture]
      assert.equal(manifest.sha256,pin.sha256);assert.equal(manifest.sizeBytes,pin.size)
      const bytes=await downloadPinned(manifest.url,pin,32*1024*1024)
      const name=machines[h.machine],home=h.user==='root'?'/root':'/home/probe',root=home+'/existing-probe',unit='komari-agent.service'
      const unitDirectory=h.user==='root'?'/etc/systemd/system':home+'/.config/systemd/user'
      const uid=docker('exec',name,'id','-u',h.user)
      const systemctl=(...args)=>docker('exec','--user',h.user,'--env',`XDG_RUNTIME_DIR=/run/user/${uid}`,'--env',`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,name,'systemctl',...(h.user==='root'?[]:['--user']),...args)
      docker('exec',name,'mkdir','-p',root,unitDirectory)
      const config=Buffer.from(JSON.stringify({endpoint:servers[h.service].agentEndpoint,token:h.token,disable_auto_update:true,disable_web_ssh:true,interval:5,info_report_interval:1,month_rotate:0,get_ip_addr_from_nic:true}))
      const text=`[Unit]\nDescription=Isolated existing monitoring probe\nAfter=network.target\n[Service]\nType=simple\nExecStart=${root}/agent --config ${root}/config.json\nWorkingDirectory=${root}\nRestart=always\n[Install]\nWantedBy=${h.user==='root'?'multi-user.target':'default.target'}\n`
      for(const [path,data,mode] of [[root+'/agent',bytes,'700'],[root+'/config.json',config,'600'],[unitDirectory+'/'+unit,text,'600']]) {
        command('docker',['exec','-i',name,'python3','-c','import sys,pathlib; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())',path],data)
        docker('exec',name,'chown',`${h.user}:${h.user}`,path);docker('exec',name,'chmod',mode,path)
      }
      docker('exec',name,'chown',`${h.user}:${h.user}`,root,unitDirectory)
      const before=await sample(h);systemctl('daemon-reload');systemctl('enable','--now',unit)
      await wait(async()=>await sample(h)>before&&(await h.rpc('admin:getClient')).version?.replace(/^v/,'')===manifest.version)
      const pid=systemctl('show',unit,'--property=MainPID','--value');assert(/^[1-9][0-9]*$/.test(pid))
      assert.equal(docker('exec',name,'sha256sum',`/proc/${pid}/exe`).split(' ')[0],manifest.sha256)
      await h.history.capture()
      const retained=()=>{
        assert.equal(systemctl('show',unit,'--property=UnitFileState','--value'),'disabled')
        assert.equal(docker('exec',name,'sha256sum',root+'/agent').split(' ')[0],manifest.sha256)
        assert.equal(docker('exec',name,'sha256sum',root+'/config.json').split(' ')[0],createHash('sha256').update(config).digest('hex'))
        assert.equal(docker('exec',name,'sha256sum',unitDirectory+'/'+unit).split(' ')[0],createHash('sha256').update(text).digest('hex'))
      }
      record('agent-existing-unmanaged-prepared',{version:manifest.version,processSha256:manifest.sha256,originalSampleAt:await sample(h),appDatabaseUntouched:true})
      return {unit,retained}
    }
    await rm(serverFile)
    return {hosts,servers,release,observe,sample,fresh,retained,hold,cleanup,architecture,trust,catalog,prepareLegacy}
  } catch(e) {await cleanup();throw e}
}
