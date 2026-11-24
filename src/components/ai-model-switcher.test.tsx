import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIModelSwitcher } from './ai-model-switcher'
import type { AISettings } from '@/lib/ai'

const codex: AISettings = {
  backend: 'codex-cli',
  provider: 'openai',
  apiKey: '',
  model: '',
  customBaseUrl: '',
  customModel: '',
}

describe('AIModelSwitcher', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })

  afterEach(() => {
    cleanup()
  })

  it('syncs pinned favorite models across multiple mounted terminal tabs without overwriting', () => {
    render(
      <div>
        <div data-testid="tab-1">
          <AIModelSwitcher settings={codex} onChange={vi.fn()} />
        </div>
        <div data-testid="tab-2">
          <AIModelSwitcher settings={codex} onChange={vi.fn()} />
        </div>
      </div>,
    )

    const [trigger1, trigger2] = screen.getAllByTestId('ai-model-switcher')
    fireEvent.click(trigger1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin model' })[0])
    fireEvent.click(trigger1) // close tab 1 popover

    fireEvent.click(trigger2)
    // Tab 2 must already see Tab 1's pin (1 unpin button), and pinning a second model keeps both.
    expect(screen.getAllByRole('button', { name: 'Unpin model' })).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin model' })[0])
    expect(screen.getAllByRole('button', { name: 'Unpin model' })).toHaveLength(2)

    const stored = JSON.parse(localStorage.getItem('shellbeam.aiFavoriteModels') ?? '{}') as Record<string, string[]>
    expect(stored['codex-cli']).toHaveLength(2)
  })
})
