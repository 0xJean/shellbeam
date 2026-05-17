import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { toInvokeErrorMessage } from '@/lib/invoke-error'
import type { AuthType } from '@/lib/ssh'

export type BrowserSource =
  | { kind: 'url'; url: string }
  | { kind: 'html'; html: string; baseUrl?: string; title?: string }
  | { kind: 'markdown'; markdown: string; baseUrl?: string; title?: string }

export interface BrowserStateEventPayload {
  browserId: string
  sessionId: string
  url?: string | null
  title?: string | null
  isLoading?: boolean
  error?: string | null
  canGoBack?: boolean
  canGoForward?: boolean
}

const BROWSER_STATE_EVENT = 'shellbeam://browser-state'
const BROWSER_WINDOW_CLOSED_EVENT = 'shellbeam://browser-window-closed'

export interface BrowserWindowClosedEventPayload {
  browserId: string
  sessionId: string
}

export function isLoopbackBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0'
  } catch {
    return false
  }
}

export function rewriteBrowserUrlToLocalForward(value: string, localPort: number): string {
  const url = new URL(value)
  url.hostname = '127.0.0.1'
  url.port = String(localPort)
  return url.toString()
}

export function restoreBrowserUrlFromLocalForward(value: string, originalUrl: string, localPort: number): string {
  const resolved = new URL(value)
  if (resolved.hostname !== '127.0.0.1' || resolved.port !== String(localPort)) return value

  const original = new URL(originalUrl)
  original.pathname = resolved.pathname
  original.search = resolved.search
  original.hash = resolved.hash
  return original.toString()
}

function toSourcePayload(source: BrowserSource) {
  if (source.kind === 'url') {
    return {
      kind: 'url',
      url: source.url,
    }
  }

  if (source.kind === 'html') {
    return {
      kind: 'html',
      html: source.html,
      baseUrl: source.baseUrl,
      title: source.title,
    }
  }

  return {
    kind: 'markdown',
    markdown: source.markdown,
    html: renderMarkdownToHtmlDocument(source.markdown, source.baseUrl, source.title),
    baseUrl: source.baseUrl,
    title: source.title,
  }
}

export async function openEmbeddedBrowser(params: {
  browserId: string
  sessionId: string
  proxyUrl?: string
}) {
  try {
    await invoke('open_embedded_browser', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function openBrowserWindow(params: {
  browserId: string
  sessionId: string
  proxyUrl?: string
}) {
  try {
    await invoke('open_browser_window', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function closeBrowserWindow(browserId: string, sessionId: string) {
  try {
    await invoke('close_browser_window', { browserId, sessionId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function updateBrowserBounds(browserId: string, bounds: { x: number; y: number; width: number; height: number }) {
  try {
    await invoke('update_browser_bounds', { browserId, bounds })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function showBrowserWebview(browserId: string) {
  try {
    await invoke('show_browser_webview', { browserId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function hideBrowserWebview(browserId: string) {
  try {
    await invoke('hide_browser_webview', { browserId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function startBrowserPortForward(params: {
  browserId: string
  sessionId: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  remoteHost: string
  remotePort: number
  acceptHostKey?: boolean
}): Promise<number> {
  try {
    return await invoke<number>('start_browser_port_forward', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function prepareBrowserPortForward(params: {
  browserId: string
  sessionId: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  targetUrl: string
  acceptHostKey?: boolean
}): Promise<{ localPort: number; resolvedUrl: string }> {
  try {
    const target = new URL(params.targetUrl)
    const localPort = await invoke<number>('start_browser_port_forward', {
      request: {
        sessionId: params.sessionId,
        browserId: params.browserId,
        host: params.host,
        port: params.port,
        username: params.username,
        authType: params.authType,
        password: params.password,
        privateKey: params.privateKey,
        jumpHost: params.jumpHost,
        jumpPort: params.jumpPort,
        jumpUser: params.jumpUser,
        remoteHost: target.hostname,
        remotePort: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
        acceptHostKey: params.acceptHostKey,
      },
    })
    return {
      localPort,
      resolvedUrl: rewriteBrowserUrlToLocalForward(params.targetUrl, localPort),
    }
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function stopBrowserPortForward(browserId: string) {
  try {
    await invoke('stop_browser_port_forward', { browserId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function startBrowserSocksProxy(params: {
  sessionId: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  acceptHostKey?: boolean
}): Promise<number> {
  try {
    return await invoke<number>('start_browser_socks_proxy', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function startBrowserHttpProxy(params: {
  sessionId: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  acceptHostKey?: boolean
}): Promise<number> {
  try {
    return await invoke<number>('start_browser_http_proxy', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function stopBrowserHttpProxy(sessionId: string) {
  try {
    await invoke('stop_browser_http_proxy', { sessionId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function stopBrowserSocksProxy(sessionId: string) {
  try {
    await invoke('stop_browser_socks_proxy', { sessionId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function loadBrowserSource(params: {
  browserId: string
  sessionId: string
  source: BrowserSource
}) {
  try {
    await invoke('load_browser_source', {
      request: {
        browserId: params.browserId,
        sessionId: params.sessionId,
        source: toSourcePayload(params.source),
      },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function reloadBrowserWindow(params: { browserId: string; sessionId: string }) {
  try {
    await invoke('reload_browser_window', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function goBackBrowserWindow(params: { browserId: string; sessionId: string }) {
  try {
    await invoke('go_back_browser_window', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function goForwardBrowserWindow(params: { browserId: string; sessionId: string }) {
  try {
    await invoke('go_forward_browser_window', { request: params })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function listenToBrowserStateEvents(
  browserId: string,
  handler: (payload: BrowserStateEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<BrowserStateEventPayload>(BROWSER_STATE_EVENT, (event) => {
    if (event.payload.browserId !== browserId) return
    handler(event.payload)
  })
}

export async function listenToAllBrowserStateEvents(
  handler: (payload: BrowserStateEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<BrowserStateEventPayload>(BROWSER_STATE_EVENT, (event) => {
    handler(event.payload)
  })
}

export async function listenToBrowserWindowClosedEvents(
  handler: (payload: BrowserWindowClosedEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<BrowserWindowClosedEventPayload>(BROWSER_WINDOW_CLOSED_EVENT, (event) => {
    handler(event.payload)
  })
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

function renderMarkdownCodeBlocks(markdown: string) {
  return markdown.replace(/```([\w-]+)?\n([\s\S]*?)```/g, (_match, language: string | undefined, code: string) => {
    const label = language ? `<div class="code-block-language">${escapeHtml(language)}</div>` : ''
    return `${label}<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`
  })
}

function markdownToHtmlBody(markdown: string) {
  const normalized = renderMarkdownCodeBlocks(markdown)
  const lines = normalized.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listItems: string[] = []
  let paragraph: string[] = []

  function flushList() {
    if (listItems.length === 0) return
    html.push(`<ul>${listItems.join('')}</ul>`)
    listItems = []
  }

  function flushParagraph() {
    if (paragraph.length === 0) return
    html.push(`<p>${paragraph.join(' ')}</p>`)
    paragraph = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.startsWith('<div class="code-block-language">') || line.startsWith('<pre><code>') || line === '</code></pre>') {
      flushList()
      flushParagraph()
      html.push(line)
      continue
    }
    if (!line.trim()) {
      flushList()
      flushParagraph()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushList()
      flushParagraph()
      const level = heading[1].length
      html.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`)
      continue
    }

    const list = line.match(/^[-*]\s+(.*)$/)
    if (list) {
      flushParagraph()
      listItems.push(`<li>${renderInlineMarkdown(list[1].trim())}</li>`)
      continue
    }

    flushList()
    paragraph.push(renderInlineMarkdown(line.trim()))
  }

  flushList()
  flushParagraph()
  return html.join('\n')
}

export function renderMarkdownToHtmlDocument(markdown: string, baseUrl?: string, title?: string) {
  const safeTitle = escapeHtml(title ?? 'Markdown Preview')
  const baseTag = baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : ''
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    ${baseTag}
    <style>
      :root { color-scheme: light dark; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; line-height: 1.6; background: #0f172a; color: #e2e8f0; }
      main { max-width: 920px; margin: 0 auto; }
      a { color: #60a5fa; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; background: rgba(148,163,184,0.15); padding: 0.1rem 0.35rem; border-radius: 0.35rem; }
      pre { overflow: auto; padding: 1rem; border-radius: 0.75rem; background: rgba(15,23,42,0.92); }
      .code-block-language { margin-top: 1.25rem; margin-bottom: 0.4rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }
      blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid rgba(96,165,250,0.45); color: #cbd5e1; }
      h1,h2,h3,h4,h5,h6 { line-height: 1.25; }
      ul { padding-left: 1.5rem; }
    </style>
  </head>
  <body>
    <main>
      ${markdownToHtmlBody(markdown)}
    </main>
  </body>
</html>`
}
