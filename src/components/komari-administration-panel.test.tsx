import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KomariAdministrationPanel } from './komari-administration-panel'
import { closeBrowserWindow, hideBrowserWebview, loadBrowserSource, openEmbeddedBrowser, openBrowserWindow, showBrowserWebview } from '@/lib/browser'

vi.mock('@/lib/browser', () => ({ closeBrowserWindow: vi.fn(), hideBrowserWebview: vi.fn(), loadBrowserSource: vi.fn(), openEmbeddedBrowser: vi.fn(), openBrowserWindow: vi.fn(), showBrowserWebview: vi.fn(), updateBrowserBounds: vi.fn(async () => {}) }))
const onClose = vi.fn()
const onError = vi.fn()
function panel(vaultId = 'vault-a') { return <KomariAdministrationPanel vaultId={vaultId} integrationId="saved" name="Example source" url="https://komari.example/base/" onClose={onClose} onError={onError} /> }
beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 64, width: 800, height: 600 } as DOMRect)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(openEmbeddedBrowser).mockResolvedValue(undefined)
  vi.mocked(loadBrowserSource).mockResolvedValue(undefined)
  vi.mocked(closeBrowserWindow).mockResolvedValue(undefined)
  vi.mocked(hideBrowserWebview).mockResolvedValue(undefined)
  vi.mocked(showBrowserWebview).mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  // Drain the existing browser lease's delayed native close between cases.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)) })
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})

describe('Komari main-window native child lifecycle', () => {
  it('portals outside transformed settings containers and opens one child in StrictMode', async () => {
    const view = render(<StrictMode><div style={{ transform: 'translateX(0)' }}>{panel()}</div></StrictMode>)
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    expect(openEmbeddedBrowser).toHaveBeenCalledTimes(1)
    expect(openBrowserWindow).not.toHaveBeenCalled()
    expect(showBrowserWebview).toHaveBeenCalled()
    const [{ browserId, sessionId }] = vi.mocked(openEmbeddedBrowser).mock.calls[0]
    expect(browserId).toBe(sessionId)
    expect(loadBrowserSource).toHaveBeenCalledWith({ browserId, sessionId, source: { kind: 'url', url: 'https://komari.example/base/' } })
    view.unmount()
    expect(hideBrowserWebview).toHaveBeenCalledWith(browserId)
    await waitFor(() => expect(closeBrowserWindow).toHaveBeenCalledExactlyOnceWith(browserId, sessionId))
  })

  it('closes a child whose native creation completes after the settings scope is gone, without navigation or display', async () => {
    let finish!: () => void
    vi.mocked(openEmbeddedBrowser).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(panel('late-vault'))
    await waitFor(() => expect(openEmbeddedBrowser).toHaveBeenCalledTimes(1))
    const [{ browserId, sessionId }] = vi.mocked(openEmbeddedBrowser).mock.calls[0]
    view.unmount()
    await act(async () => { finish() })
    await waitFor(() => expect(closeBrowserWindow).toHaveBeenCalledExactlyOnceWith(browserId, sessionId))
    expect(showBrowserWebview).not.toHaveBeenCalled()
    expect(loadBrowserSource).not.toHaveBeenCalled()
  })

  it('reuses a rapid same-scope reopening while the old lease is waiting to close', async () => {
    const first = render(panel('reuse-vault'))
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
    first.unmount()
    const second = render(panel('reuse-vault'))
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(2))
    expect(openEmbeddedBrowser).toHaveBeenCalledTimes(1)
    expect(closeBrowserWindow).not.toHaveBeenCalled()
    second.unmount()
    await waitFor(() => expect(closeBrowserWindow).toHaveBeenCalledTimes(1))
  })

  it('offers keyboard close and restores the initiating control focus after dismissal', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus()
    const view = render(panel('focus-vault'))
    await waitFor(() => expect(loadBrowserSource).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Close server administration' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
