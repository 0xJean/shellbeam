import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PcSessionTabBar } from './pc-tab-bar'

beforeEach(() => localStorage.setItem('shellbeam.locale', 'en'))

const props = { sessionTabs: [], activeSessionId: 's1', isDashboard: false, isSplit: false, onSelectSession: vi.fn(), onCloseSession: vi.fn(), onGoToDashboard: vi.fn() }

describe('PcSessionTabBar AI button', () => {
  it('toggles the AI bar and shows whether it is open', () => {
    const onToggleAi = vi.fn()
    const { rerender } = render(<PcSessionTabBar {...props} onToggleAi={onToggleAi} />)
    const button = screen.getByTestId('pc-tab-ai')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(onToggleAi).toHaveBeenCalledOnce()
    rerender(<PcSessionTabBar {...props} onToggleAi={onToggleAi} aiOpen />)
    expect(screen.getByTestId('pc-tab-ai')).toHaveAttribute('aria-pressed', 'true')
  })
})
