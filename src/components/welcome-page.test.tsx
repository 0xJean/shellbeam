import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomePage } from './welcome-page'
import { useWelcomePage } from '@/hooks/use-welcome-page'

beforeEach(() => { localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('welcome onboarding', () => {
  it('offers the tutorial, skip, monitoring, and MCP without initiating any action', () => {
    const onDismiss = vi.fn()
    const onOpenGuide = vi.fn()
    render(<WelcomePage onDismiss={onDismiss} onOpenGuide={onOpenGuide} />)
    expect(screen.getByText('Native server monitoring')).toBeInTheDocument()
    expect(screen.getByText('Agent access (MCP)')).toBeInTheDocument()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onOpenGuide).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start the guided tour' }))
    expect(onOpenGuide).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Go straight to the app' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('shows on first launch and respects existing welcomeSeen on later launches', () => {
    const first = renderHook(useWelcomePage)
    expect(first.result.current.show).toBe(true)
    act(() => first.result.current.dismiss())
    expect(first.result.current.show).toBe(false)
    first.unmount()
    const later = renderHook(useWelcomePage)
    expect(later.result.current.show).toBe(false)
    expect(localStorage.getItem('shellbeam.guide.v1')).toBeNull()
  })
  it('can dismiss even if local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { result } = renderHook(useWelcomePage)
    act(() => result.current.dismiss())
    expect(result.current.show).toBe(false)
  })
})
