import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openBrowserWindow,
  prepareBrowserPortForward,
  stopBrowserPortForward,
  closeBrowserWindow,
  isLoopbackBrowserUrl,
  loadBrowserSource,
  listenToBrowserWindowClosedEvents,
  renderMarkdownToHtmlDocument,
  restoreBrowserUrlFromLocalForward,
  rewriteBrowserUrlToLocalForward,
} from '@/lib/browser'

const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined as unknown))
const listenMock = vi.hoisted(() => vi.fn(async (_event, _handler) => () => {}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

describe('browser markdown rendering', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    listenMock.mockClear()
  })

  it('renders headings, lists, inline formatting, code blocks, and base url', () => {
    const html = renderMarkdownToHtmlDocument('# Title\n\n- one\n- two\n\nVisit [docs](https://example.com) and `code`.\n\n```ts\nconst answer = 42\n```', 'https://base.example/', 'Preview')

    expect(html).toContain('<title>Preview</title>')
    expect(html).toContain('<base href="https://base.example/">')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('<a href="https://example.com">docs</a>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<div class="code-block-language">ts</div>')
    expect(html).toContain('<pre><code>const answer = 42</code></pre>')
  })

  it('recognizes loopback browser urls', () => {
    expect(isLoopbackBrowserUrl('http://localhost:3000')).toBe(true)
    expect(isLoopbackBrowserUrl('http://127.0.0.1:8080/path')).toBe(true)
    expect(isLoopbackBrowserUrl('http://0.0.0.0:5173')).toBe(true)
    expect(isLoopbackBrowserUrl('https://example.com')).toBe(false)
  })

  it('rewrites loopback urls to local forwarded ports and restores the original url', () => {
    const rewritten = rewriteBrowserUrlToLocalForward('http://localhost:3000/admin?tab=1#logs', 49123)
    expect(rewritten).toBe('http://127.0.0.1:49123/admin?tab=1#logs')
    expect(restoreBrowserUrlFromLocalForward('http://127.0.0.1:49124/admin', 'http://localhost:3000/admin?tab=1#logs', 49123)).toBe('http://127.0.0.1:49124/admin')
  })

  it('prepares a browser port forward and returns a rewritten url', async () => {
    invokeMock.mockResolvedValueOnce(49123)

    const result = await prepareBrowserPortForward({
      browserId: 'browser-1',
      sessionId: 'session-1',
      host: '10.0.0.8',
      port: 22,
      username: 'root',
      authType: 'privateKey',
      privateKey: 'private-key',
      targetUrl: 'http://localhost:3000/admin',
    })

    expect(invokeMock).toHaveBeenCalledWith('start_browser_port_forward', {
      request: {
        browserId: 'browser-1',
        sessionId: 'session-1',
        host: '10.0.0.8',
        port: 22,
        username: 'root',
        authType: 'privateKey',
        password: undefined,
        privateKey: 'private-key',
        jumpHost: undefined,
        jumpPort: undefined,
        jumpUser: undefined,
        remoteHost: 'localhost',
        remotePort: 3000,
        acceptHostKey: undefined,
      },
    })
    expect(result).toEqual({
      localPort: 49123,
      resolvedUrl: 'http://127.0.0.1:49123/admin',
    })
  })

  it('passes password auth through when preparing a browser port forward', async () => {
    invokeMock.mockResolvedValueOnce(49124)

    await prepareBrowserPortForward({
      browserId: 'browser-2',
      sessionId: 'session-2',
      host: '10.0.0.9',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      password: 'top-secret',
      targetUrl: 'http://localhost:8080',
    })

    expect(invokeMock).toHaveBeenCalledWith('start_browser_port_forward', {
      request: {
        browserId: 'browser-2',
        sessionId: 'session-2',
        host: '10.0.0.9',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        password: 'top-secret',
        privateKey: undefined,
        jumpHost: undefined,
        jumpPort: undefined,
        jumpUser: undefined,
        remoteHost: 'localhost',
        remotePort: 8080,
        acceptHostKey: undefined,
      },
    })
  })

  it('opens a browser window with the expected payload', async () => {
    await openBrowserWindow({
      browserId: 'browser-1',
      sessionId: 'session-1',
      proxyUrl: undefined,
    })

    expect(invokeMock).toHaveBeenCalledWith('open_browser_window', {
      request: {
        browserId: 'browser-1',
        sessionId: 'session-1',
        proxyUrl: undefined,
      },
    })
  })

  it('loads html browser sources into the browser window', async () => {
    await loadBrowserSource({
      browserId: 'browser-1',
      sessionId: 'session-1',
      source: { kind: 'html', html: '<h1>Hello</h1>', title: 'Hello' },
    })

    expect(invokeMock).toHaveBeenCalledWith('load_browser_source', {
      request: {
        browserId: 'browser-1',
        sessionId: 'session-1',
        source: {
          kind: 'html',
          html: '<h1>Hello</h1>',
          baseUrl: undefined,
          title: 'Hello',
        },
      },
    })
  })

  it('listens for browser window close events', async () => {
    const handler = vi.fn()
    await listenToBrowserWindowClosedEvents(handler)

    expect(listenMock).toHaveBeenCalledWith('shellbeam://browser-window-closed', expect.any(Function))
  })

  it('closes a browser window by browser id and session id', async () => {
    await closeBrowserWindow('browser-1', 'session-1')

    expect(invokeMock).toHaveBeenCalledWith('close_browser_window', {
      browserId: 'browser-1',
      sessionId: 'session-1',
    })
  })

  it('stops a browser port forward by browser id', async () => {
    await stopBrowserPortForward('browser-1')

    expect(invokeMock).toHaveBeenCalledWith('stop_browser_port_forward', {
      browserId: 'browser-1',
    })
  })
})
