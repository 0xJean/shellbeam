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

test('reports omit credentials and payloads while retaining visibility booleans', () => {
  const report = safeDetails({ password: 'synthetic', nativePayload: { credential: 'synthetic' }, endpointUrl: 'https://example.com', ocrTitleMatched: true, screenshot: 'notification-visible.png', jobId: '00000000-0000-4000-8000-000000000001' })
  assert.deepEqual(report, { ocrTitleMatched: true, screenshot: 'notification-visible.png', jobId: '00000000-0000-4000-8000-000000000001' })
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
