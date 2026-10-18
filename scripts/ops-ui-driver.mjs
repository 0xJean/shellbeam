// A deliberately small W3C client for disposable native-app acceptance. It
// never evaluates JavaScript, substitutes IPC, dumps a DOM, or logs payloads.
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const elementKey = 'element-6066-11e4-a52e-4f735466cecf'
const recoverable = new Set(['no such element', 'stale element reference', 'no such alert'])

export class WebDriverError extends Error {
  constructor(code) {
    const safe = /^[a-z ]{1,64}$/.test(code ?? '') ? code : 'transport failure'
    super(`webdriver: ${safe}`)
    this.code = safe
  }
}

export class UiElement {
  constructor(driver, id) { this.driver = driver; this.id = id }
  click() { return this.driver.click(this) }
  fill(value) { return this.driver.fill(this, value) }
  getText() { return this.driver.text(this) }
  getAttribute(name) { return this.driver.attr(this, name) }
  find(locator) { return this.driver.find(locator, this) }
  findAll(locator) { return this.driver.findAll(locator, this) }
}

export class OpsUiDriver {
  constructor(baseUrl, { requestTimeoutMs = 60_000 } = {}) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('driver endpoint must be loopback')
    this.baseUrl = url.origin
    this.requestTimeoutMs = requestTimeoutMs
    this.sessionId = null
    this.lastInteraction = null
  }
  async request(method, path, body) {
    let response
    let payload
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      // Screenshots can be larger than regular responses, but remain bounded.
      if (Number(response.headers.get('content-length')) > 16 * 1024 * 1024) throw new Error()
      const raw = await response.text()
      if (raw.length > 16 * 1024 * 1024) throw new Error()
      payload = JSON.parse(raw)
    } catch { throw new WebDriverError('transport failure') }
    if (!response.ok || payload.value?.error) throw new WebDriverError(payload.value?.error)
    return payload.value
  }
  route(suffix = '') {
    if (!this.sessionId) throw new WebDriverError('invalid session id')
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`
  }
  async start(application) {
    const value = await this.request('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'wry', 'tauri:options': { application }, unhandledPromptBehavior: 'ignore',
    } } })
    if (!value || typeof value.sessionId !== 'string') throw new WebDriverError('session not created')
    this.sessionId = value.sessionId
    await this.request('POST', this.route('/timeouts'), { implicit: 0, pageLoad: 60_000, script: 10_000 })
    return this
  }
  async stop() {
    if (!this.sessionId) return
    await this.request('DELETE', this.route())
    this.sessionId = null
  }
  locator(locator) {
    if (typeof locator !== 'string' || !locator) throw new Error('invalid locator')
    return locator.startsWith('xpath=') ? { using: 'xpath', value: locator.slice(6) } : { using: 'css selector', value: locator }
  }
  async find(locator, parent) {
    if (locator instanceof UiElement) return locator
    const value = await this.request('POST', this.route(`${parent ? `/element/${encodeURIComponent(parent.id)}` : ''}/element`), this.locator(locator))
    if (!value?.[elementKey]) throw new WebDriverError('no such element')
    return new UiElement(this, value[elementKey])
  }
  async findAll(locator, parent) {
    const values = await this.request('POST', this.route(`${parent ? `/element/${encodeURIComponent(parent.id)}` : ''}/elements`), this.locator(locator))
    if (!Array.isArray(values)) throw new WebDriverError('unknown error')
    return values.map(value => new UiElement(this, value[elementKey]))
  }
  async elementRoute(locator, suffix) {
    const element = await this.find(locator)
    return this.route(`/element/${encodeURIComponent(element.id)}${suffix}`)
  }
  async click(locator) {
    this.noteInteraction('click', locator)
    const element = await this.interactable(locator)
    return this.clickElement(element)
  }
  noteInteraction(kind, locator) {
    // Keep only a fixed test-control identifier. Never retain locator text,
    // input contents, error payloads or credential values in diagnostics.
    const control = typeof locator === 'string' ? [...locator.matchAll(/data-testid=["']([a-z0-9-]{1,80})["']/g)].at(-1)?.[1] : null
    this.lastInteraction = { kind, control: control ?? 'native-control' }
  }
  async clickElement(element) {
    try { return await this.request('POST', await this.elementRoute(element, '/click'), {}) }
    catch (error) {
      // The click has opened a real modal. Leave it for the caller's explicit
      // accept/dismiss; never retry a click or automatically consent.
      if (error.code !== 'unexpected alert open') throw error
    }
  }
  async fill(locator, value) {
    this.noteInteraction('fill', locator)
    const element = await this.interactable(locator)
    const tag = await this.request('GET', await this.elementRoute(element, '/name'))
    // WebKit types ordinary characters as text interactions. A literal LF is
    // not its virtual Enter key; multiline controls need the standard W3C key
    // token so the real editor emits a line break and a genuine input event.
    const text = String(value)
    const keys = tag === 'textarea' ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\uE007') : text
    await this.request('POST', await this.elementRoute(element, '/clear'), {})
    await this.request('POST', await this.elementRoute(element, '/value'), { text: keys, value: [...keys] })
  }
  async text(locator) { return this.request('GET', await this.elementRoute(locator, '/text')) }
  async attr(locator, name) {
    // Read current input state, not the original HTML value attribute.
    return this.request('GET', await this.elementRoute(locator, `/${name === 'value' ? 'property' : 'attribute'}/${encodeURIComponent(name)}`))
  }
  async isSelected(locator) { return this.request('GET', await this.elementRoute(locator, '/selected')) }
  async isDisplayed(locator) { return this.request('GET', await this.elementRoute(locator, '/displayed')) }
  async isEnabled(locator) { return this.request('GET', await this.elementRoute(locator, '/enabled')) }
  interactable(locator, options) {
    return this.until(async () => {
      const element = await this.find(locator)
      return await this.isDisplayed(element) && await this.isEnabled(element) ? element : false
    }, options)
  }
  async select(locator, value) {
    this.noteInteraction('select', locator)
    const element = await this.interactable(locator)
    const options = await element.findAll('option')
    for (const option of options) {
      if (await option.getAttribute('value') === value) {
        if (!await this.isEnabled(option)) throw new WebDriverError('element not interactable')
        // W3C's native option click selects and emits the genuine input/change
        // events. The select is visible; its closed popup need not be opened.
        await this.clickElement(option)
        return
      }
    }
    throw new WebDriverError('no such element')
  }
  async until(fn, { timeoutMs = 30_000 } = {}) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try { const result = await fn(); if (result) return result }
      catch (error) { if (!recoverable.has(error.code)) throw error }
      await delay(200)
    }
    throw new WebDriverError('timeout')
  }
  waitFor(locator, options) {
    return this.until(async () => {
      const element = await this.find(locator)
      return await this.isDisplayed(element) ? element : false
    }, options)
  }
  alertText() { return this.request('GET', this.route('/alert/text')) }
  acceptAlert() { return this.request('POST', this.route('/alert/accept'), {}) }
  dismissAlert() { return this.request('POST', this.route('/alert/dismiss'), {}) }
  async screenshot(path) {
    const png = await this.request('GET', this.route('/screenshot'))
    if (typeof png !== 'string' || png.length > 16 * 1024 * 1024) throw new WebDriverError('unknown error')
    await writeFile(path, Buffer.from(png, 'base64'), { mode: 0o600, flag: 'wx' })
  }
}
