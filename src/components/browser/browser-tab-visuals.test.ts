import { describe, expect, it } from 'vitest'
import { filterBrowserTabs, getBrowserRouteTone, getBrowserTabDensity, getBrowserTabFaviconCandidates, getBrowserTabMonogram } from './browser-tab-visuals'

describe('browser tab visuals helpers', () => {
  it('derives stable monograms for url and preview tabs', () => {
    expect(getBrowserTabMonogram({
      title: 'Example',
      sourceKind: 'url',
      url: 'https://www.google.com/search?q=shellbeam',
    })).toBe('G')

    expect(getBrowserTabMonogram({
      title: 'Preview',
      sourceKind: 'markdown',
      url: '',
    })).toBe('M')

    expect(getBrowserTabMonogram({
      title: 'Preview',
      sourceKind: 'html',
      url: '',
    })).toBe('H')
  })

  it('builds favicon candidates only for http urls', () => {
    expect(getBrowserTabFaviconCandidates('https://example.com/docs')).toEqual([
      'https://example.com/favicon.ico',
    ])

    expect(getBrowserTabFaviconCandidates('http://127.0.0.1:8080')).toEqual([
      'http://127.0.0.1:8080/favicon.ico',
    ])

    expect(getBrowserTabFaviconCandidates('data:text/html,hello')).toEqual([])
    expect(getBrowserTabFaviconCandidates('')).toEqual([])
  })

  it('filters browser tabs by title, url, and route detail', () => {
    const tabs = [
      {
        id: '1',
        title: 'Google',
        sourceKind: 'url' as const,
        url: 'https://www.google.com',
        routeIndicator: { label: 'Server', detail: 'Requests originate from the server' },
      },
      {
        id: '2',
        title: 'Readme Preview',
        sourceKind: 'markdown' as const,
        url: '',
        routeIndicator: { label: 'Local', detail: 'Preview content is rendered locally' },
      },
    ]

    expect(filterBrowserTabs(tabs, 'server').map((tab) => tab.id)).toEqual(['1'])
    expect(filterBrowserTabs(tabs, 'readme').map((tab) => tab.id)).toEqual(['2'])
    expect(filterBrowserTabs(tabs, 'google.com').map((tab) => tab.id)).toEqual(['1'])
  })

  it('switches tab density based on total tab count', () => {
    expect(getBrowserTabDensity(3)).toBe('comfortable')
    expect(getBrowserTabDensity(8)).toBe('compact')
    expect(getBrowserTabDensity(16)).toBe('dense')
  })

  it('treats preview tabs as a neutral route tone', () => {
    expect(getBrowserRouteTone('local', 'markdown')).toBe('preview')
    expect(getBrowserRouteTone('remote', 'url')).toBe('remote')
    expect(getBrowserRouteTone(null, null)).toBe('local')
  })
})
