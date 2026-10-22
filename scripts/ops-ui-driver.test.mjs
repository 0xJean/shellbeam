import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { OpsUiDriver, WebDriverError } from './ops-ui-driver.mjs'
import { guardUiEnvironment, safeDetails } from './run-ops-ui-live.mjs'

test('runner refuses ordinary desktops and root before loading fixture data', () => {
  assert.throws(() => guardUiEnvironment({}, 'darwin', 501), /disposable/)
  assert.throws(() => guardUiEnvironment({}, 'linux', 0), /disposable/)
  assert.throws(() => guardUiEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 1001), /disposable/)
})

test('transport only accepts a loopback HTTP endpoint', () => {
  for (const endpoint of ['https://127.0.0.1:4444', 'http://example.com', 'http://127.0.0.1/a']) assert.throws(() => new OpsUiDriver(endpoint), /loopback/)
})

test('element rectangles use only the standard read-only W3C rect endpoint for selectors and retained handles', async t => {
  const calls = [], expected = { x: 17.25, y: -12, width: 840, height: 54 }
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* No application payload is retained. */ }
    calls.push([request.method, request.url])
    const value = request.url.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'row-id' } : expected
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`)
  driver.sessionId = 's'
  assert.deepEqual(await driver.rect('[data-testid="workspace-service-row"]'), expected)
  const row = await driver.find('[data-testid="workspace-service-row"]')
  assert.deepEqual(await driver.rect(row), expected)
  assert.deepEqual(calls, [['POST', '/session/s/element'], ['GET', '/session/s/element/row-id/rect'], ['POST', '/session/s/element'], ['GET', '/session/s/element/row-id/rect']])
  assert.equal(driver.lastInteraction, null)
})

test('reports omit credentials and payloads while retaining visibility booleans', () => {
  const report = safeDetails({ password: 'synthetic', nativePayload: { credential: 'synthetic' }, endpointUrl: 'https://example.com', ocrTitleMatched: true, screenshot: 'notification-visible.png', jobId: '00000000-0000-4000-8000-000000000001' })
  assert.deepEqual(report, { ocrTitleMatched: true, screenshot: 'notification-visible.png', jobId: '00000000-0000-4000-8000-000000000001' })
})

test('horizontal list readiness reads only numeric W3C geometry, never input values or script', async t => {
  const calls = [], geometry = { clientWidth: 1054, scrollWidth: 1184, scrollLeft: 130 }
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Discard locator payload. */ }
    calls.push([request.method, request.url])
    const value = request.url.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'list' }
      : geometry[request.url.split('/').at(-1)]
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`); driver.sessionId = 's'
  assert.deepEqual(await driver.horizontalScrollState('[data-testid="host-list-scroll-viewport"]'), { width: 1054, contentWidth: 1184, left: 130 })
  assert.deepEqual(calls, [['POST', '/session/s/element'], ...['clientWidth', 'scrollWidth', 'scrollLeft'].map(name => ['GET', `/session/s/element/list/property/${name}`])])
  geometry.scrollLeft = 'SYNTHETIC_PRIVATE_VALUE'
  await assert.rejects(driver.horizontalScrollState('[data-testid="host-list-scroll-viewport"]'), error => error.message === 'invalid horizontal scroll geometry')
  assert.equal(driver.lastInteraction, null)
})

test('failed clicks retain only numeric geometry and never retry, scroll, or read credential values', async t => {
  const calls = [], element = id => ({ 'element-6066-11e4-a52e-4f735466cecf': id })
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : null
    calls.push({ method: request.method, path: request.url, body })
    let value = null, status = 200
    if (request.url.endsWith('/elements')) value = [element('outer'), element('inner')]
    else if (request.url.endsWith('/element')) value = element(body.value === 'html' ? 'viewport' : 'target')
    else if (request.url.endsWith('/displayed') || request.url.endsWith('/enabled')) value = true
    else if (request.url.endsWith('/rect')) value = { x: 50, y: 900, width: 80, height: 30, private: 'SYNTHETIC_CREDENTIAL' }
    else if (request.url.includes('/property/')) value = request.url.endsWith('/scrollTop') ? 100 : request.url.endsWith('/scrollLeft') ? 'SYNTHETIC_CREDENTIAL' : 800
    else if (request.url.endsWith('/click')) { status = 400; value = { error: 'element not interactable', message: 'SYNTHETIC_CREDENTIAL' } }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`); driver.sessionId = 's'
  await assert.rejects(driver.click('[data-testid="host-save"]'), error => error.code === 'element not interactable')
  const report = safeDetails(driver.lastClickDiagnostics)
  assert.equal(report.available, true); assert.equal(report.target.y, 900); assert.equal(report.target.scrollTop, 100)
  assert.equal(report.target.scrollLeft, null); assert.equal(report.ancestors.length, 2)
  assert(!JSON.stringify(report).includes('SYNTHETIC'))
  assert.deepEqual(calls.filter(call => call.method === 'POST' && !/\/elements?$/.test(call.path)).map(call => call.path), ['/session/s/element/target/click'])
  assert.equal(calls.some(call => /\/text$|\/property\/value$|\/execute\/|\/actions$/.test(call.path)), false)
  assert.deepEqual(driver.lastInteraction, { kind: 'click', control: 'host-save' })
})

test('unsupported geometry endpoints keep partial evidence and the original click failure', async t => {
  const calls = []
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* No field values are retained. */ }
    calls.push(request.url)
    let status = 200, value = null
    if (request.url.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'target' }
    else if (request.url.endsWith('/rect')) value = { x: 20, y: 900, width: 80, height: 30 }
    else if (request.url.endsWith('/displayed') || request.url.endsWith('/enabled')) value = true
    else { status = 400; value = { error: request.url.endsWith('/click') ? 'element not interactable' : 'unsupported operation', message: 'PRIVATE_FIELD_VALUE' } }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`); driver.sessionId = 's'
  await assert.rejects(driver.click('[data-testid="host-save"]'), error => error.code === 'element not interactable')
  const report = safeDetails(driver.lastClickDiagnostics)
  assert.equal(report.target.y, 900)
  assert.equal(report.viewport.width, 80)
  assert.equal(report.target.clientHeight, null)
  assert.deepEqual(report.ancestors, [])
  assert(report.errors.some(error => error.stage === 'ancestors' && error.code === 'unsupported-operation'))
  assert(!JSON.stringify(report).includes('PRIVATE'))
  assert.equal(calls.filter(path => path.endsWith('/click')).length, 1)
  assert.equal(calls.some(path => /\/text$|\/property\/value$|\/execute\/|\/actions$/.test(path)), false)
})

test('W3C confirmation stays explicit, errors are redacted, and input state uses properties', async t => {
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    calls.push({ method: request.method, path: request.url, ...(body ? { body: JSON.parse(body) } : {}) })
    let value = null
    let status = 200
    if (request.url === '/session') value = { sessionId: 's', capabilities: {} }
    else if (request.url.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'e' }
    else if (request.url.endsWith('/click')) { status = 500; value = { error: 'unexpected alert open', message: 'SYNTHETIC_PRIVATE_OUTPUT' } }
    else if (request.url.endsWith('/alert/text')) value = 'Confirm restart?'
    else if (request.url.endsWith('/property/value')) value = 'current-input'
    else if (request.url.endsWith('/displayed') || request.url.endsWith('/enabled')) value = true
    else if (request.url.endsWith('/attribute/fail')) { status = 500; value = { error: 'unknown error', message: 'SYNTHETIC_PRIVATE_OUTPUT', stacktrace: 'SYNTHETIC_PRIVATE_OUTPUT' } }
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`)
  await driver.start('/test/application')
  assert.equal(calls[0].body.capabilities.alwaysMatch.unhandledPromptBehavior, 'ignore')
  await driver.click('[data-testid="restart"]')
  assert.equal(await driver.alertText(), 'Confirm restart?')
  assert.equal(calls.filter(call => call.path.endsWith('/click')).length, 1)
  assert.equal(calls.filter(call => call.path.endsWith('/alert/accept')).length, 0)
  await driver.dismissAlert()
  assert.equal(await driver.attr('input', 'value'), 'current-input')
  await assert.rejects(driver.attr('input', 'fail'), error => error instanceof WebDriverError && error.message === 'webdriver: unknown error' && !JSON.stringify(error).includes('SYNTHETIC'))
  await driver.stop()
})

test('readiness waits for a visible enabled control before exactly one mutation', async t => {
  let visibleReads = 0
  let enabledReads = 0
  const mutations = []
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Request bodies never enter logs. */ }
    let value = null
    if (request.url.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'e' }
    else if (request.url.endsWith('/displayed')) value = ++visibleReads > 1
    else if (request.url.endsWith('/enabled')) value = ++enabledReads > 1
    else if (request.method === 'POST') mutations.push(request.url)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`)
  driver.sessionId = 's'
  await driver.fill('[data-testid="vault-master-password"]', 'SYNTHETIC-PRIVATE-INPUT')
  assert(visibleReads >= 3 && enabledReads >= 2)
  assert.deepEqual(mutations, ['/session/s/element/e/clear', '/session/s/element/e/value'])
  assert.deepEqual(driver.lastInteraction, { kind: 'fill', control: 'vault-master-password' })
  assert(!JSON.stringify(driver.lastInteraction).includes('SYNTHETIC'))
})

test('multiline input uses real W3C Enter keys and never writes through JavaScript', async t => {
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    calls.push({ path: request.url, ...(body ? { body: JSON.parse(body) } : {}) })
    let value = null
    if (request.url.endsWith('/element')) value = { 'element-6066-11e4-a52e-4f735466cecf': 'e' }
    else if (request.url.endsWith('/displayed') || request.url.endsWith('/enabled')) value = true
    else if (request.url.endsWith('/name')) value = 'textarea'
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`)
  driver.sessionId = 's'
  await driver.fill('[data-testid="host-private-key"]', 'SYNTHETIC\r\nMULTILINE\nVALUE\n')
  const writes = calls.filter(call => call.path.endsWith('/value'))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.text, 'SYNTHETIC\uE007MULTILINE\uE007VALUE\uE007')
  assert.equal(calls.filter(call => call.path.endsWith('/clear')).length, 1)
  assert.equal(calls.some(call => call.path.includes('/execute/')), false)
})

test('controlled field replacement uses explicit keyboard actions and releases modifiers before typing', async t => {
  const calls=[]
  const server=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk)
    const raw=Buffer.concat(chunks).toString();calls.push({path:request.url,...(raw?{body:JSON.parse(raw)}:{})})
    let value=null
    if(request.url.endsWith('/element'))value={'element-6066-11e4-a52e-4f735466cecf':'e'}
    else if(request.url.endsWith('/displayed')||request.url.endsWith('/enabled'))value=true
    else if(request.url.endsWith('/name'))value='input'
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({value}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const driver=new OpsUiDriver(`http://127.0.0.1:${server.address().port}`);driver.sessionId='s'
  await driver.fill('[data-testid="host-port"]','32787',{keyboardClear:true})
  const writes=calls.filter(c=>c.path.endsWith('/actions')||c.path.endsWith('/click')||c.path.endsWith('/clear')||c.path.endsWith('/value'))
  assert.deepEqual(writes.map(c=>c.path),['/session/s/element/e/click','/session/s/actions','/session/s/element/e/value'])
  assert.deepEqual(writes[1].body.actions,[{type:'key',id:'field-keyboard',actions:[{type:'keyDown',value:'\uE009'},{type:'keyDown',value:'a'},{type:'keyUp',value:'a'},{type:'keyUp',value:'\uE009'},{type:'keyDown',value:'\uE003'},{type:'keyUp',value:'\uE003'}]}])
  assert.equal(writes[2].body.text,'32787');assert.equal(calls.some(c=>c.path.includes('/execute/')),false)
})

for (const mode of ['visible', 'settling', 'outside-window']) test(`application dropdown ${mode}: keyboard navigation never clicks an option outside the window`, async t => {
  const longMenu = mode !== 'visible', outsideWindow = mode === 'outside-window'
  const calls = [], element = id => ({ 'element-6066-11e4-a52e-4f735466cecf': id })
  const count = longMenu ? 9 : 1, target = count - 1
  const disabled = new Set(longMenu ? [0, 4] : [])
  const enabled = Array.from({ length: count }, (_, i) => i).filter(i => !disabled.has(i))
  let menuReads = 0, active = target, scrollReads = 0, boundsReads = 0
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : null
    calls.push({ path: request.url, body })
    let value = null
    const option = /\/element\/choice-(\d+)\//.exec(request.url)?.[1]
    if (request.url.endsWith('/actions')) {
      const keys = body.actions[0].actions
      assert.equal(body.actions[0].id, 'menu-keyboard')
      assert.deepEqual(keys.map(k => k.type), ['keyDown', 'keyUp'])
      assert.equal(keys[0].value, keys[1].value)
      if (keys[0].value === '\uE011') active = enabled[0]
      else { assert.equal(keys[0].value, '\uE015'); active = enabled[enabled.indexOf(active) + 1] }
    }
    else if (request.url.endsWith('/elements')) value = body.value === 'option' ? [element('native-option')]
      : body.value.endsWith('[role="option"]') ? Array.from({ length: count }, (_, i) => element(`choice-${i}`))
      : ++menuReads === 1 ? [element('closing-menu')] : []
    else if (request.url.endsWith('/element')) value = element(body.value === 'html' ? 'viewport' : body.value.includes('[role="listbox"]') ? 'menu' : 'select')
    else if (request.url.endsWith('/displayed') || request.url.endsWith('/enabled')) value = true
    else if (request.url.endsWith('/property/value')) value = 'logs'
    else if (request.url.endsWith('/attribute/data-value')) value = Number(option) === target ? 'logs' : `other-${option}`
    else if (request.url.endsWith('/attribute/aria-disabled')) value = disabled.has(Number(option)) ? 'true' : null
    else if (request.url.endsWith('/attribute/id')) value = `_r_1_-${option}`
    else if (request.url.endsWith('/attribute/aria-activedescendant')) value = `_r_1_-${active}`
    else if (request.url.endsWith('/property/offsetTop')) value = target * 36 + 4
    else if (request.url.endsWith('/property/offsetHeight')) value = 36
    else if (request.url.endsWith('/property/clientHeight')) value = request.url.includes('/viewport/') ? 800 : 238
    else if (request.url.endsWith('/property/clientWidth')) value = 1280
    else if (request.url.endsWith('/rect')) value = { x: 182, y: longMenu && (++boundsReads < 3 || outsideWindow) ? 2770 : 519, width: 245, height: 240 }
    else if (request.url.endsWith('/property/scrollTop')) value = ++scrollReads > 1 && longMenu ? 90 : 0
    else if (request.url.endsWith('/attribute/data-app-select')) value = 'true'
    else if (request.url.endsWith('/attribute/aria-controls')) value = '_r_1_'
    else if (request.url.includes('/choice-') && request.url.endsWith('/click')) {
      assert.equal(Number(option), target)
      assert.equal(active, target)
      if (longMenu) {
        assert(scrollReads >= 2, 'wait for the real scroll position before the only option click')
        assert(boundsReads >= 3, 'an option inside a menu outside the viewport is still not clickable')
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() })
  const driver = new OpsUiDriver(`http://127.0.0.1:${server.address().port}`); driver.sessionId = 's'
  if (outsideWindow) {
    // Bound this synthetic permanently-clipped fixture, not product timeouts.
    const until = driver.until.bind(driver)
    driver.until = fn => until(fn, { timeoutMs: 500 })
    await assert.rejects(driver.select('[data-testid="host-ops-open"]', 'logs'), /timeout/)
    assert.deepEqual(calls.filter(call => call.path.endsWith('/click')).map(call => call.path), ['/session/s/element/select/click'])
    assert.equal(driver.lastClickDiagnostics.available, true)
    assert.equal(driver.lastClickDiagnostics.target.y, 2770)
    assert.equal(calls.some(call => call.path.includes('/execute/')), false)
    return
  }
  await driver.select('[data-testid="host-ops-open"]', 'logs')
  assert.deepEqual(calls.filter(call => call.path.endsWith('/click')).map(call => call.path), ['/session/s/element/select/click', `/session/s/element/choice-${target}/click`])
  assert.equal(calls.filter(call => call.path.endsWith('/actions')).length, enabled.length)
  assert(calls.some(call => call.body?.value === '[id="_r_1_"][role="listbox"] [role="option"]'))
  assert.equal(menuReads, 2, 'selection waits until the closing portal is no longer displayed')
  assert.equal(calls.some(call => call.path.includes('/execute/')), false)
})
