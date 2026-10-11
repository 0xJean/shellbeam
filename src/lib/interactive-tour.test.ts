import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from './locales/en'
import zhCN from './locales/zh-CN'
import { findTourTarget, INTERACTIVE_TOURS, TOUR_STEPS, waitForTourTarget } from './interactive-tour'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [{}]) as unknown as DOMRectList
  })
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('tour targets', () => {
  it('ignores hidden duplicates and resolves an already rendered target', async () => {
    document.body.innerHTML = '<button hidden data-tour="test"></button><button data-tour="test"></button>'
    const target = document.body.lastElementChild
    expect(findTourTarget('[data-tour="test"]')).toBe(target)
    await expect(waitForTourTarget('[data-tour="test"]', new AbortController().signal)).resolves.toBe(target)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for lazy content and cleans up its timers', async () => {
    const waiting = waitForTourTarget('[data-tour="test"]', new AbortController().signal)
    document.body.innerHTML = '<button data-tour="test"></button>'
    await expect(waiting).resolves.toBe(document.body.firstElementChild)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles CSS-only visibility changes', async () => {
    document.body.innerHTML = '<button data-tour="test"></button>'
    const visible = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ visibility: 'hidden' } as CSSStyleDeclaration)
    const waiting = waitForTourTarget('[data-tour="test"]', new AbortController().signal)
    visible.mockReturnValue({ visibility: 'visible' } as CSSStyleDeclaration)
    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toBe(document.body.firstElementChild)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds waits for missing targets', async () => {
    const waiting = waitForTourTarget('[data-tour="missing"]', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(waiting).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts pending and already cancelled waits without leaking timers', async () => {
    const abort = new AbortController()
    const waiting = waitForTourTarget('[data-tour="missing"]', abort.signal)
    abort.abort()
    await expect(waiting).resolves.toBeUndefined()
    await expect(waitForTourTarget('[data-tour="missing"]', abort.signal)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('provides matching bilingual copy for every tour step and control', () => {
  const keys = (dict: Record<string, string>) => Object.keys(dict).filter((key) => key.startsWith('tour.')).sort()
  expect(keys(en)).toEqual(keys(zhCN))
  for (const key of keys(en)) {
    expect(en[key].trim(), key).not.toBe('')
    expect(zhCN[key].trim(), key).not.toBe('')
  }
  for (const id of INTERACTIVE_TOURS) {
    for (const step of TOUR_STEPS[id]) {
      for (const suffix of ['title', 'body']) {
        expect(en[`tour.${step.key}.${suffix}`]).toBeTruthy()
        expect(zhCN[`tour.${step.key}.${suffix}`]).toBeTruthy()
      }
    }
  }
})
