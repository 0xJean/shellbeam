import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMobileDevice, triggerMobileBackForTest, useMobileBackHandler } from './mobile-back'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function BackConsumer({ active, onBack }: { active: boolean; onBack: () => void }) {
  useMobileBackHandler(active, onBack)
  return null
}

describe('mobile-back', () => {
  it('detects mobile OS user agents accurately', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15; Pixel 9)')
    expect(isMobileDevice()).toBe(true)

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    expect(isMobileDevice()).toBe(true)

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(isMobileDevice()).toBe(false)
  })

  it('invokes active back handlers in LIFO order and returns false when none active', () => {
    const first = vi.fn()
    const second = vi.fn()

    expect(triggerMobileBackForTest()).toBe(false)

    const { rerender } = render(
      <>
        <BackConsumer active onBack={first} />
        <BackConsumer active onBack={second} />
      </>,
    )

    expect(window.__shellbeamHandleAndroidBack?.()).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    rerender(
      <>
        <BackConsumer active onBack={first} />
        <BackConsumer active={false} onBack={second} />
      </>,
    )

    expect(window.__shellbeamHandleAndroidBack?.()).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
