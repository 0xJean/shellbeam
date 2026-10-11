import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { startInteractiveTour } from '@/lib/interactive-tour-driver'
import { InteractiveTour } from './interactive-tour'

vi.mock('@/lib/interactive-tour-driver', () => ({ startInteractiveTour: vi.fn() }))
const dispose = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(startInteractiveTour).mockReturnValue({ dispose, cancel: vi.fn() })
})
afterEach(() => { cleanup(); localStorage.clear() })

it('creates only one live controller under StrictMode and disposes it on unmount', async () => {
  const props = { id: 'hosts' as const, valid: true, setHostFormOpen: vi.fn(), onFinish: vi.fn() }
  const view = render(<StrictMode><I18nProvider><InteractiveTour {...props} /></I18nProvider></StrictMode>)
  await act(async () => { await vi.dynamicImportSettled() })
  expect(props.onFinish.mock.calls).toEqual([])
  await waitFor(() => expect(startInteractiveTour).toHaveBeenCalledTimes(1))
  const options = vi.mocked(startInteractiveTour).mock.calls[0][0]
  act(() => options.onWaiting(false))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(startInteractiveTour).toHaveBeenCalledTimes(1)
  act(() => options.setHostFormOpen(true))
  expect(props.setHostFormOpen).toHaveBeenCalledWith(true)
  view.unmount()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(props.onFinish).not.toHaveBeenCalled()
})

it('disposes and interrupts when the route, session or Vault becomes invalid', async () => {
  const props = { id: 'monitor' as const, setHostFormOpen: vi.fn(), onFinish: vi.fn() }
  const view = render(<I18nProvider><InteractiveTour {...props} valid /></I18nProvider>)
  await act(async () => { await vi.dynamicImportSettled() })
  await waitFor(() => expect(startInteractiveTour).toHaveBeenCalledTimes(1))
  view.rerender(<I18nProvider><InteractiveTour {...props} valid={false} /></I18nProvider>)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(props.onFinish).toHaveBeenCalledExactlyOnceWith('interrupted')
})

it('does not start a late dynamic import after unmount', async () => {
  const view = render(<I18nProvider><InteractiveTour id="mcp" valid setHostFormOpen={vi.fn()} onFinish={vi.fn()} /></I18nProvider>)
  view.unmount()
  await act(async () => { await vi.dynamicImportSettled() })
  expect(startInteractiveTour).not.toHaveBeenCalled()
})
