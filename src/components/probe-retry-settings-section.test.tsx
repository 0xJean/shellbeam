import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROBE_RETRY_SETTINGS_STORAGE_KEY } from '@/lib/probe-retry-settings'
import { ProbeRetrySettingsSection } from './probe-retry-settings-section'

describe('ProbeProvider retry settings section', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })
  afterEach(cleanup)

  it('edits and persists the shared recovery policy', () => {
    render(<ProbeRetrySettingsSection />)
    expect(screen.getByTestId('probe-retry-settings')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Max recovery retries'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Initial backoff'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save retry policy' }))
    expect(screen.getByRole('status')).toHaveTextContent('Retry policy saved')
    expect(JSON.parse(localStorage.getItem(PROBE_RETRY_SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ maxRetries: 4, retryDelayMs: 500 })
  })
})
