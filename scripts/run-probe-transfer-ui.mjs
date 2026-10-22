import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { open, readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyTransferUiReport } from './probe-transfer-ui-report.mjs'
import { OpsUiDriver } from './ops-ui-driver.mjs'
import { guardUiEnvironment, safeDetails, freePort, appProcesses, stopProcessGroup } from './run-ops-ui-live.mjs'
import { createTransferUiFixture } from './probe-transfer-ui-fixture.mjs'
import { setupTransferUi, runTransferUiJourney } from './probe-transfer-ui-journey.mjs'

export async function main(env=process.env) {
  guardUiEnvironment(env)
  const directory=env.SHELLBEAM_TRANSFER_UI_PRIVATE
  assert(directory && directory.startsWith(env.RUNNER_TEMP+'/shellbeam-transfer-ui-'))
  const info=await lstat(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o777)===0o700)
  const project=resolve('.'),app='/usr/bin/shellbeam-ops-ui-acceptance',webdriver=env.SHELLBEAM_TRANSFER_UI_DRIVER
  assert(webdriver?.startsWith(env.RUNNER_TEMP+'/shellbeam-webdriver/'))
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),env.GITHUB_SHA)
  for(const [kind,key] of [['data','XDG_DATA_HOME'],['config','XDG_CONFIG_HOME'],['cache','XDG_CACHE_HOME'],['state','XDG_STATE_HOME'],['runtime','XDG_RUNTIME_DIR']])assert.equal(env[key],join(directory,kind))
  assert.equal((await appProcesses(app)).length,0)
  const prefix='sb-ui-transfer-'+randomBytes(6).toString('hex')
  await writeFile(join(directory,'owner'),prefix,{mode:0o600,flag:'wx'})
  const artifacts=join(env.RUNNER_TEMP,'shellbeam-transfer-ui-artifacts');await mkdir(artifacts,{mode:0o700})
  const report={schemaVersion:1,success:false,headCommit:env.SHELLBEAM_OPS_UI_HEAD_SHA,checkedOutCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,events:[],screenshots:[],cleanup:false,applicationStopped:false}
  const record=(name,details={})=>{assert(/^[a-z0-9-]{1,90}$/.test(name));report.events.push({name,...safeDetails(details)});assert(report.events.length<=200)}
  let child,log,driver,fixture,stage='fixture'
  const stop=async(crash=false)=>{
    if(crash)for(const pid of await appProcesses(app))process.kill(pid,'SIGKILL')
    else if(driver?.sessionId){driver.requestTimeoutMs=5000;try{await driver.stop()}catch{}}
    await stopProcessGroup(child);child=null
    for(const pid of await appProcesses(app))try{process.kill(pid,'SIGTERM')}catch{}
    for(let n=0;n<50&&(await appProcesses(app)).length;n++)await delay(100)
    assert.equal((await appProcesses(app)).length,0);if(log)await log.close();log=null
  }
  const launch=async()=>{
    assert.equal((await appProcesses(app)).length,0);const port=await freePort(),nativePort=await freePort();assert.notEqual(port,nativePort)
    log=await open(join(directory,`driver-${Date.now()}.log`),'wx',0o600)
    child=spawn(webdriver,['--port',String(port),'--native-port',String(nativePort),'--native-driver','/usr/bin/WebKitWebDriver'],{detached:true,stdio:['ignore',log.fd,log.fd],env:{...env,TAURI_WEBVIEW_AUTOMATION:'true'}})
    await writeFile(join(directory,'driver-pid'),String(child.pid),{mode:0o600})
    let failed=false;child.on('error',()=>{failed=true})
    driver=new OpsUiDriver(`http://127.0.0.1:${port}`)
    await driver.until(async()=>{assert(!failed&&child.exitCode===null);try{return(await driver.request('GET','/status')).ready===true}catch{return false}},{timeoutMs:20000})
    await driver.start(app);assert.equal((await appProcesses(app)).length,1);record('installed-app-started',{ordinaryUser:true,productionBinary:true})
    return driver
  }
  const restart=async password=>{
    await stop(true);record('installed-app-crash-confirmed',{exited:true});await launch()
    const form='dialog[open] [data-testid="vault-password-form"]';await driver.waitFor(form,{timeoutMs:60000});assert.equal(await driver.attr(form,'data-mode'),'unlock')
    await driver.fill('[data-testid="vault-master-password"]',password);await driver.click('[data-testid="vault-submit"]');await driver.until(async()=>!(await driver.findAll('dialog[open]')).length)
    await driver.waitFor('[data-testid="pc-dashboard"]');record('same-vault-unlocked-after-restart',{passed:true});return driver
  }
  const checkpoint=async name=>{
    assert(/^transfer-[a-z-]{1,60}$/.test(name));const path=join(artifacts,name+'.png');await driver.screenshot(path)
    const bytes=await readFile(path);assert(bytes.length<8*1024*1024&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    report.screenshots.push({file:name+'.png',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})
  }
  try {
    fixture=await createTransferUiFixture({directory,project,prefix,record});stage='launch';await launch();stage='native-onboarding'
    const state=await setupTransferUi({driver,fixture,record});stage='migration-and-recovery'
    report.journey=await runTransferUiJourney({driver,fixture,state,record,restart,checkpoint});report.success=report.journey.passed===true
  }catch(e){
    report.failureLocation=String(e?.stack??'').match(/(?:probe-transfer-ui-journey|probe-transfer-ui-fixture|probe-transfer-history)\.mjs:[0-9:]+/)?.[0]
    report.failedStage=stage;report.failureCode=/^[a-z0-9_ :.-]{1,100}$/i.test(e.message)?e.message:'transfer_ui_assertion_failed';report.lastInteraction=driver?.lastInteraction;process.exitCode=1
    // Read only fixed UI flags and product error codes. Never retain form
    // values, DOM dumps, server responses or arbitrary alert text.
    if(driver?.sessionId)try{
      const diagnostics={editorVisible:false,saveVisible:false,saveEnabled:false,verifyVisible:false,verifyEnabled:false,alerts:0,codes:[]}
      for(const [key,selector] of [['editor','[data-testid="komari-connection-editor"]'],['save','xpath=//*[@data-testid="komari-settings"]//button[normalize-space(.)="Save connection"]'],['verify','xpath=//*[@data-testid="komari-settings"]//button[normalize-space(.)="Verify connection and discover nodes"]']]){
        const elements=await driver.findAll(selector)
        if(elements.length){diagnostics[key+'Visible']=await driver.isDisplayed(elements[0]);if(key!=='editor')diagnostics[key+'Enabled']=await driver.isEnabled(elements[0])}
      }
      for(const alert of await driver.findAll('[role="alert"]'))if(await driver.isDisplayed(alert)){diagnostics.alerts++;diagnostics.codes.push(...(await driver.text(alert)).match(/\b(?:KOMARI|MONITORING|VAULT)_[A-Z_]{1,80}\b/g)??[])}
      for(const control of ['host-card','host-ops-details-toggle','compatible-agent-tools','probe-transfer-panel'])diagnostics[control]=(await driver.findAll(`[data-testid="${control}"]`)).length
      report.uiFailure=diagnostics
      if(stage==='migration-and-recovery'){
        let safe=true
        for(const field of await driver.findAll('input[type="password"],textarea,#komari-api-key'))if(await driver.attr(field,'value'))safe=false
        if(safe && !(await driver.findAll('iframe')).length)await checkpoint('transfer-failure')
      }
    }catch{}
  }
  finally{
    try{await stop();report.applicationStopped=true}catch{report.success=false}
    try{if(fixture)await fixture.cleanup();report.cleanup=report.events.some(e=>e.name==='transfer-fixture-cleaned'&&e.containersRemoved&&e.networkRemoved&&e.serversStopped);if(!report.cleanup)report.success=false}catch{report.success=false}
    if(report.success)try{verifyTransferUiReport(report)}catch{report.success=false;report.failureCode='transfer_ui_report_incomplete'}
    await writeFile(join(env.RUNNER_TEMP,'shellbeam-transfer-ui-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o644,flag:'wx'})
  }
  if(!report.success)process.exitCode=1
}
main().catch(()=>{console.error('Transfer UI: setup or cleanup refused');process.exitCode=1})
