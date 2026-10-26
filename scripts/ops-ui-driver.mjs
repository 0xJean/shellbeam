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
    this.lastClickDiagnostics = null
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
    this.lastClickDiagnostics = null
    try { return await this.request('POST', await this.elementRoute(element, '/click'), {}) }
    catch (error) {
      // The click has opened a real modal. Leave it for the caller's explicit
      // accept/dismiss; never retry a click or automatically consent.
      if (error.code !== 'unexpected alert open') {
        if (['element not interactable', 'element click intercepted'].includes(error.code)) {
          this.lastClickDiagnostics = await this.readClickGeometry(element).catch(() => ({ available: false }))
        }
        throw error
      }
    }
  }
  async readClickGeometry(element) {
    // Failure observation only: no scrolling, focus, retry, JS evaluation or
    // reads of text/field values. These fixed numeric properties are safe even
    // when an ancestor contains a credential form.
    const errors = []
    const observe = async (stage, read) => {
      try { return await read() } catch (error) {
        // Keep a fixed stage and allowlisted transport code, never the message.
        const known = ['unsupported operation', 'unknown command', 'unknown error', 'stale element reference', 'no such element', 'invalid selector', 'transport failure']
        errors.push({ stage, code: known.includes(error.code) ? error.code.replaceAll(' ', '-') : 'unavailable' })
        return null
      }
    }
    const geometry = async (target, stage) => {
      const rect = await observe(`${stage}-rect`, () => this.rect(target))
      const result = {}
      for (const field of ['x', 'y', 'width', 'height']) {
        result[field] = typeof rect?.[field] === 'number' && Number.isFinite(rect[field]) ? rect[field] : null
      }
      for (const field of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollLeft', 'scrollTop']) {
        const value = await observe(`${stage}-${field}`, async () => this.request('GET', await this.elementRoute(target, `/property/${field}`)))
        result[field] = typeof value === 'number' && Number.isFinite(value) ? value : null
      }
      return result
    }
    const result = { available: true,
      displayed: await observe('displayed', () => this.isDisplayed(element)),
      enabled: await observe('enabled', () => this.isEnabled(element)),
      target: await geometry(element, 'target'), viewport: null, ancestors: [], errors }
    const viewport = await observe('viewport', () => this.find('html'))
    if (viewport) result.viewport = await geometry(viewport, 'viewport')
    // A driver can reject ancestor XPath or one property without invalidating
    // the already captured target rect. Preserve each independent observation.
    const ancestors = await observe('ancestors', () => this.findAll('xpath=ancestor::*', element))
    for (const [index, ancestor] of (ancestors ?? []).reverse().slice(0, 8).entries()) result.ancestors.push(await geometry(ancestor, `ancestor-${index}`))
    return result
  }
  async fill(locator, value, { keyboardClear = false, tabFrom } = {}) {
    this.noteInteraction('fill', locator)
    const element = await this.interactable(locator)
    const tag = await this.request('GET', await this.elementRoute(element, '/name'))
    // WebKit types ordinary characters as text interactions. A literal LF is
    // not its virtual Enter key; multiline controls need the standard W3C key
    // token so the real editor emits a line break and a genuine input event.
    const text = String(value)
    const keys = tag === 'textarea' ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\uE007') : text
    if (tabFrom !== undefined) await this.focusNextFrom(element, tabFrom)
    if (keyboardClear || tabFrom !== undefined) {
      // Explicit Linux key actions produce genuine input events for React
      // controlled fields; modifier characters inside /value do not.
      if (tabFrom === undefined) await this.clickElement(element)
      await this.request('POST', this.route('/actions'), { actions: [{ type: 'key', id: 'field-keyboard', actions: [
        { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
        { type: 'keyDown', value: '\uE003' }, { type: 'keyUp', value: '\uE003' },
      ] }] })
    } else await this.request('POST', await this.elementRoute(element, '/clear'), {})
    await this.request('POST', await this.elementRoute(element, '/value'), { text: keys, value: [...keys] })
  }
  async focusNextFrom(element, tabFrom) {
    // A field can be clipped by a scrollable dialog. Follow the actual tab
    // order once, from the caller's focused control, and verify both ends.
    // Never guess, retry, inject JS or change a value to obtain focus.
    const previous = await this.find(tabFrom)
    const activeId = async () => (await this.request('GET', this.route('/element/active')))?.[elementKey]
    if (await activeId() !== previous.id) throw new WebDriverError('element not interactable')
    await this.request('POST', this.route('/actions'), { actions: [{ type: 'key', id: 'field-keyboard', actions: [
      { type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' },
    ] }] })
    if (await activeId() !== element.id) throw new WebDriverError('element not interactable')
  }
  async text(locator) { return this.request('GET', await this.elementRoute(locator, '/text')) }
  async attr(locator, name) {
    // Read current input state, not the original HTML value attribute.
    return this.request('GET', await this.elementRoute(locator, `/${name === 'value' ? 'property' : 'attribute'}/${encodeURIComponent(name)}`))
  }
  async isSelected(locator) { return this.request('GET', await this.elementRoute(locator, '/selected')) }
  async isDisplayed(locator) { return this.request('GET', await this.elementRoute(locator, '/displayed')) }
  async isEnabled(locator) { return this.request('GET', await this.elementRoute(locator, '/enabled')) }
  async rect(locator) { return this.request('GET', await this.elementRoute(locator, '/rect')) }
  async horizontalScrollState(locator) {
    const element = await this.find(locator)
    const [width, contentWidth, left] = await Promise.all(['clientWidth', 'scrollWidth', 'scrollLeft'].map(
      field => this.request('GET', this.route(`/element/${encodeURIComponent(element.id)}/property/${field}`)),
    ))
    if (![width, contentWidth, left].every(Number.isFinite)) throw new Error('invalid horizontal scroll geometry')
    return { width, contentWidth, left }
  }
  interactable(locator, options) {
    return this.until(async () => {
      const element = await this.find(locator)
      return await this.isDisplayed(element) && await this.isEnabled(element) ? element : false
    }, options)
  }
  async select(locator, value, { tabFrom } = {}) {
    this.noteInteraction('select', locator)
    const element = await this.interactable(locator)
    const options = await element.findAll('option')
    for (const option of options) {
      if (await option.getAttribute('value') === value) {
        if (!await this.isEnabled(option)) throw new WebDriverError('element not interactable')
        if (await this.attr(element, 'data-app-select') === 'true') {
          if (tabFrom !== undefined) {
            await this.focusNextFrom(element, tabFrom)
            // Enter must only open a closed application menu, never commit an
            // already-open menu's active value before the requested choice.
            if (await this.attr(element, 'aria-expanded') !== 'false') throw new WebDriverError('element not interactable')
            await this.request('POST', this.route('/actions'), { actions: [{ type: 'key', id: 'menu-keyboard', actions: [
              { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' },
            ] }] })
            await this.until(async () => await this.attr(element, 'aria-expanded') === 'true')
          } else await this.clickElement(element)
          const menuId = await this.attr(element, 'aria-controls')
          if (!menuId || !/^[A-Za-z0-9_:.-]+$/.test(menuId)) throw new WebDriverError('no such element')
          const choices = await this.findAll(`[id=${JSON.stringify(menuId)}][role="listbox"] [role="option"]`)
          for (const choice of choices) {
            if (await this.attr(choice, 'data-value') !== value) continue
            if (!await this.isDisplayed(choice) || await this.attr(choice, 'aria-disabled') === 'true') throw new WebDriverError('element not interactable')
            // WebKit does not reveal clipped children of the custom listbox
            // on option click. Use the product's keyboard navigation first;
            // the active option scrolls through its normal React handler.
            // Keep the final selection a single real, visible option click.
            let firstEnabled = true
            for (const candidate of choices) {
              if (await this.attr(candidate, 'aria-disabled') === 'true') continue
              const optionId = await this.attr(candidate, 'id')
              if (!optionId || !optionId.startsWith(`${menuId}-`)) throw new WebDriverError('no such element')
              const key = firstEnabled ? '\uE011' : '\uE015'
              firstEnabled = false
              await this.request('POST', this.route('/actions'), { actions: [{ type: 'key', id: 'menu-keyboard', actions: [
                { type: 'keyDown', value: key }, { type: 'keyUp', value: key },
              ] }] })
              await this.until(async () => await this.attr(element, 'aria-activedescendant') === optionId)
              if (candidate.id === choice.id) break
            }
            const menu = await this.find(`[id=${JSON.stringify(menuId)}][role="listbox"]`)
            const viewport = await this.find('html')
            await this.until(async () => {
              const read = async (target, field) => this.request('GET', await this.elementRoute(target, `/property/${field}`))
              const top = await read(choice, 'offsetTop'), height = await read(choice, 'offsetHeight')
              const scroll = await read(menu, 'scrollTop'), visible = await read(menu, 'clientHeight')
              // A portal can follow an ancestor's asynchronous native scroll.
              // Being inside the listbox is insufficient if the entire menu
              // is still outside the window. Observe both before the click.
              const box = await this.rect(menu)
              const width = await read(viewport, 'clientWidth'), viewportHeight = await read(viewport, 'clientHeight')
              return [top, height, scroll, visible].every(Number.isFinite) && height > 0 && visible > 0
                && top >= scroll && top + height <= scroll + visible
                && [box.x, box.y, box.width, box.height, width, viewportHeight].every(Number.isFinite)
                && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0
                && box.x + box.width <= width && box.y + box.height <= viewportHeight
            }).catch(async error => {
              // Preserve safe geometry even when no click was attempted.
              this.lastClickDiagnostics = await this.readClickGeometry(choice).catch(() => ({ available: false }))
              throw error
            })
            await this.clickElement(choice)
            // The real change event can commit before the portal is removed.
            // Wait for dismissal before clicking the next form control; an
            // enabled button alone does not prove the menu stopped covering it.
            await this.until(async () => {
              for (const menu of await this.findAll(`[id=${JSON.stringify(menuId)}][role="listbox"]`)) {
                if (await this.isDisplayed(menu)) return false
              }
              return true
            })
            return
          }
          throw new WebDriverError('no such element')
        }
        if (tabFrom !== undefined) throw new WebDriverError('unsupported operation')
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
