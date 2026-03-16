import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionHeader } from './mobile-session-header'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string) => key,
}))

describe('mobile session header', () => {
  it('renders workspace mode toggle in the active session title row', () => {
    const onModeChange = vi.fn()

    render(
      <MobileSessionHeader
        sessionTabs={[
          { sessionId: 'session-1', hostName: 'OpenClaw-KK', hostAddress: '164.68.124.173', status: 'connected' },
        ]}
        activeSessionId="session-1"
        activeMode="workspace"
        onModeChange={onModeChange}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
        onNewConnection={() => {}}
        onOpenLocalTerminal={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'workspace.mode.terminal' }))

    expect(onModeChange).toHaveBeenCalledWith('terminal')
    expect(screen.getByText('OpenClaw-KK')).toBeInTheDocument()
  })
})
