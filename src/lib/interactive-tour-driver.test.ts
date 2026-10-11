import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driver, type Config, type Driver, type PopoverDOM } from 'driver.js'
import { startInteractiveTour } from './interactive-tour-driver'
import type { InteractiveTourId } from './interactive-tour'

vi.mock('driver.js', () => ({ driver: vi.fn() }))
let config: Config
let controller: ReturnType<typeof startInteractiveTour> | undefined
const drive = vi.fn()
const destroy = vi.fn()
const refresh = vi.fn()
const tick = () => vi.advanceTimersByTimeAsync(0)
const next = () => config.onNextClick?.(undefined, {}, {} as never)
const previous = () => config.onPrevClick?.(undefined, {}, {} as never)

function launch(id: InteractiveTourId, setHostFormOpen = vi.fn()) {
  const options = { id, t: (key: string) => key, onFinish: vi.fn(), onWaiting: vi.fn(), setHostFormOpen }
  controller = startInteractiveTour(options)
  return options
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  document.body.innerHTML = '<div id="root"></div>'
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  vi.mocked(driver).mockImplementation((options) => {
    config = options!
    return { drive, destroy, refresh, getConfig: () => config } as unknown as Driver
  })
})
afterEach(() => {
  controller?.dispose()
  controller = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('interactive walkthrough lifecycle', () => {
  it('allows Escape while the destination is still loading', async () => {
    const options = launch('hosts')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(driver).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not click or submit host fields, keeps the form after completion, and restores interaction', async () => {
    const root = document.getElementById('root')!
    root.inert = false
    root.innerHTML = '<button data-tour="host-create">Create</button>'
    const action = vi.fn()
    root.firstElementChild!.addEventListener('click', action)
    const prepare = vi.fn((open: boolean) => {
      if (!open) { document.querySelector('dialog')?.remove(); return }
      const dialog = document.createElement('dialog')
      dialog.open = true
      dialog.innerHTML = '<div role="document" data-tour="host-form"><input data-tour="host-address"><input data-tour="host-identity"><input data-tour="host-auth"><button data-tour="host-save">Save</button></div>'
      dialog.querySelector('[role="document"]')!.addEventListener('click', action)
      document.body.append(dialog)
    })
    const options = launch('hosts', prepare)
    await tick()
    expect(drive).toHaveBeenLastCalledWith(0)
    expect(root.inert).toBe(true)
    next(); await tick()
    expect(prepare).toHaveBeenCalledExactlyOnceWith(true)
    const dialog = document.querySelector('dialog')!
    expect((dialog.firstElementChild as HTMLElement).inert).toBe(true)
    expect(config.steps![1].element).toBe(dialog.querySelector('[data-tour="host-address"]'))
    const popover = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.className = 'driver-overlay'
    document.body.append(popover, overlay)
    config.onPopoverRender?.({ wrapper: popover } as unknown as PopoverDOM, {} as never)
    expect(popover.parentElement).toBe(dialog)
    expect(overlay.parentElement).toBe(dialog)
    expect(popover).toHaveAttribute('aria-modal', 'true')
    for (let i = 0; i < 4; i++) { next(); await tick() }
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('completed')
    expect(root.inert).toBe(false)
    expect(dialog.open).toBe(true)
    expect((dialog.firstElementChild as HTMLElement).inert).not.toBe(true)
    expect(action).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(1)
  })
  it('can return from the dialog to the first step and reattach the overlay', async () => {
    document.getElementById('root')!.innerHTML = '<button data-tour="host-create"></button>'
    launch('hosts', vi.fn((open: boolean) => {
      if (!open) { document.querySelector('dialog')!.remove(); return }
      document.body.insertAdjacentHTML('beforeend', '<dialog open><div role="document" data-tour="host-form"><input data-tour="host-address"></div></dialog>')
    }))
    await tick(); next(); await tick()
    const overlay = document.createElement('div')
    overlay.className = 'driver-overlay'
    document.body.append(overlay)
    config.onHighlighted?.(undefined, {}, {} as never)
    expect(overlay.parentElement?.tagName).toBe('DIALOG')
    previous(); await tick()
    expect(drive).toHaveBeenLastCalledWith(0)
    config.onHighlighted?.(undefined, {}, {} as never)
    expect(overlay.parentElement).toBe(document.body)
  })
  it('uses an honest one-step introduction for empty monitoring', async () => {
    document.getElementById('root')!.innerHTML = '<div data-tour="monitor-page"></div>'
    const options = launch('monitor')
    await tick()
    expect(config.steps).toHaveLength(1)
    expect(config.steps![0].popover?.description).toBe('tour.monitorEmpty')
    next(); await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('completed')
    expect(options.setHostFormOpen).not.toHaveBeenCalled()
  })
  it('waits for MCP readiness and never changes authorization controls', async () => {
    document.getElementById('root')!.innerHTML = '<section data-tour="mcp-settings" data-tour-ready="false"><label data-tour="mcp-toggle"><input type="checkbox"></label><input data-tour="mcp-client"><fieldset data-tour="mcp-hosts"></fieldset><fieldset data-tour="mcp-permissions"></fieldset><button data-tour="mcp-create"></button><div data-tour="mcp-clients"></div></section>'
    const action = vi.fn()
    document.getElementById('root')!.addEventListener('click', action)
    launch('mcp')
    await tick()
    expect(driver).not.toHaveBeenCalled()
    document.querySelector('section')!.dataset.tourReady = 'true'
    await tick()
    expect(config.steps).toHaveLength(6)
    for (let i = 0; i < 6; i++) { next(); await tick() }
    expect(document.querySelector('input')!.checked).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })
  it('uses a limited MCP introduction when the desktop form is absent', async () => {
    document.getElementById('root')!.innerHTML = '<section data-tour="mcp-settings" data-tour-ready="true"><label data-tour="mcp-toggle"></label></section>'
    launch('mcp'); await tick()
    expect(config.steps).toHaveLength(1)
    expect(config.steps![0].popover?.description).toBe('tour.mcpUnavailable')
  })
  it('cancels on Escape, preserves preexisting inert state, and disconnects observers', async () => {
    const root = document.getElementById('root')!
    root.inert = true
    root.innerHTML = '<div data-tour="monitor-page"></div>'
    const options = launch('monitor'); await tick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
    await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(root.inert).toBe(true)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(document.body).not.toHaveClass('shellbeam-tour-active')
  })
  it('interrupts on a new Vault dialog without closing or accepting it', async () => {
    document.getElementById('root')!.innerHTML = '<div data-tour="monitor-page"></div>'
    const options = launch('monitor'); await tick()
    document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
    await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('interrupted')
    expect(document.querySelector('dialog')!.open).toBe(true)
  })
  it('does not begin over an existing modal', async () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
    const options = launch('hosts'); await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('interrupted')
    expect(driver).not.toHaveBeenCalled()
  })
  it('reports disappearing targets instead of highlighting the document body', async () => {
    document.getElementById('root')!.innerHTML = '<div data-tour="monitor-page"></div>'
    const options = launch('monitor'); await tick()
    document.querySelector('[data-tour="monitor-page"]')!.remove()
    await tick()
    expect(options.onFinish).toHaveBeenCalledExactlyOnceWith('unavailable')
  })
  it('does not start after disposal during a pending page load', async () => {
    const options = launch('hosts')
    controller!.dispose()
    document.body.insertAdjacentHTML('beforeend', '<button data-tour="host-create"></button>')
    await tick()
    expect(driver).not.toHaveBeenCalled()
    expect(options.onFinish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
