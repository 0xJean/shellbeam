import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmbeddedBrowserWebview } from './embedded-browser-webview'

const native = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  bounds: vi.fn(async (_id: string, _rect: { y: number }) => {}),
}))

vi.mock('@/lib/browser', () => ({
  openEmbeddedBrowser: native.open,
  closeBrowserWindow: native.close,
  loadBrowserSource: native.load,
  showBrowserWebview: native.show,
  hideBrowserWebview: native.hide,
  updateBrowserBounds: native.bounds,
}))

let rectTop = 100
const frames: FrameRequestCallback[] = []
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const nextFrame = () => act(async () => {
  frames.splice(0).forEach((callback) => callback(0))
  await Promise.resolve()
})

beforeEach(() => {
  vi.clearAllMocks()
  rectTop = 100
  frames.length = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 10, y: rectTop, width: 800, height: 500 }) as DOMRect)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const props = { sessionId: 's', source: null, sourceRevision: 0 }

describe('EmbeddedBrowserWebview', () => {
  it('follows a container that moves without changing size', async () => {
    render(<EmbeddedBrowserWebview {...props} browserId="move" visible />)
    await flush()
    expect(native.bounds).toHaveBeenLastCalledWith('move', expect.objectContaining({ y: 100 }))
    rectTop = 136
    await nextFrame()
    await flush()
    expect(native.bounds).toHaveBeenLastCalledWith('move', expect.objectContaining({ y: 136 }))
  })

  it('sends one update at a time and skips stale ones', async () => {
    const resolvers: Array<() => void> = []
    native.bounds.mockImplementation(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
    render(<EmbeddedBrowserWebview {...props} browserId="order" visible />)
    await flush()
    expect(native.bounds).toHaveBeenCalledTimes(1)
    rectTop = 120; await nextFrame()
    rectTop = 140; await nextFrame()
    expect(native.bounds).toHaveBeenCalledTimes(1)
    await act(async () => { resolvers.shift()?.(); await Promise.resolve(); await Promise.resolve() })
    expect(native.bounds).toHaveBeenCalledTimes(2)
    expect(native.bounds).toHaveBeenLastCalledWith('order', expect.objectContaining({ y: 140 }))
    native.bounds.mockImplementation(async () => {})
    resolvers.forEach((resolve) => resolve())
  })

  it('does not hide a webview that another view has taken over', async () => {
    const view = render(
      <>
        <EmbeddedBrowserWebview {...props} browserId="shared" visible={false} />
        <EmbeddedBrowserWebview {...props} browserId="shared" visible />
      </>,
    )
    await flush()
    native.hide.mockClear()
    // The first view shows before the second hides, so the second must leave the webview alone.
    view.rerender(
      <>
        <EmbeddedBrowserWebview {...props} browserId="shared" visible />
        <EmbeddedBrowserWebview {...props} browserId="shared" visible={false} />
      </>,
    )
    await flush()
    expect(native.hide).not.toHaveBeenCalled()
  })

  it('keeps the page loaded while hidden', async () => {
    const view = render(<EmbeddedBrowserWebview {...props} browserId="keep" visible />)
    await flush()
    view.rerender(<EmbeddedBrowserWebview {...props} browserId="keep" visible={false} />)
    await flush()
    expect(native.hide).toHaveBeenCalledWith('keep')
    expect(native.close).not.toHaveBeenCalled()
  })
})
