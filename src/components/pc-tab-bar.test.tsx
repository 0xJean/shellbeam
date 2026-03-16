import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PcSessionTabBar } from './pc-tab-bar'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string) => key,
}))

describe('pc session tab bar', () => {
  it('renders workspace mode toggle inside the active session tab', () => {
    const onModeChange = vi.fn()

    render(
      <PcSessionTabBar
        sessionTabs={[
          { sessionId: 'session-1', hostName: 'OpenClaw-KK', hostAddress: '164.68.124.173', status: 'connected' },
        ]}
        activeSessionId="session-1"
        isDashboard={false}
        isSplit={false}
        activeMode="workspace"
        onModeChange={onModeChange}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
        onGoToDashboard={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'workspace.mode.terminal' }))

    expect(onModeChange).toHaveBeenCalledWith('terminal')
    expect(screen.getByText('OpenClaw-KK')).toBeInTheDocument()
  })
})
