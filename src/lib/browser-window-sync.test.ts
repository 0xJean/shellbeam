import { describe, expect, it } from 'vitest'
import { syncBrowserWindow } from '@/lib/browser-window-sync'
import type { BrowserSource } from '@/lib/browser'

describe('syncBrowserWindow', () => {
  it('opens the browser window before loading a new source', async () => {
    const calls: string[] = []
    const source: BrowserSource = { kind: 'url', url: 'https://www.google.com' }

    const loadedSourceRevision = await syncBrowserWindow({
      browserId: 'browser-1',
      sessionId: 'session-1',
      wasOpen: false,
      lastSourceRevision: undefined,
      sourceRevision: 3,
      source,
      openBrowser: async () => {
        calls.push('open')
      },
      loadSource: async () => {
        calls.push('load')
      },
    })

    expect(calls).toEqual(['open', 'load'])
    expect(loadedSourceRevision).toBe(3)
  })

  it('loads a changed source without reopening', async () => {
    const calls: string[] = []
    const source: BrowserSource = { kind: 'html', html: '<h1>Hello</h1>', title: 'Hello' }

    await syncBrowserWindow({
      browserId: 'browser-1',
      sessionId: 'session-1',
      wasOpen: true,
      lastSourceRevision: 1,
      sourceRevision: 2,
      source,
      openBrowser: async () => {
        calls.push('open')
      },
      loadSource: async () => {
        calls.push('load')
      },
    })

    expect(calls).toEqual(['load'])
  })

  it('does not reload an unchanged source revision', async () => {
    const calls: string[] = []
    const source: BrowserSource = { kind: 'url', url: 'https://example.com' }

    const loadedSourceRevision = await syncBrowserWindow({
      browserId: 'browser-1',
      sessionId: 'session-1',
      wasOpen: true,
      lastSourceRevision: 5,
      sourceRevision: 5,
      source,
      openBrowser: async () => {
        calls.push('open')
      },
      loadSource: async () => {
        calls.push('load')
      },
    })

    expect(calls).toEqual([])
    expect(loadedSourceRevision).toBe(5)
  })

  it('opens the browser even when there is no source yet', async () => {
    const calls: string[] = []

    const loadedSourceRevision = await syncBrowserWindow({
      browserId: 'browser-1',
      sessionId: 'session-1',
      wasOpen: false,
      lastSourceRevision: undefined,
      sourceRevision: 0,
      source: null,
      openBrowser: async () => {
        calls.push('open')
      },
      loadSource: async () => {
        calls.push('load')
      },
    })

    expect(calls).toEqual(['open'])
    expect(loadedSourceRevision).toBeUndefined()
  })
})
