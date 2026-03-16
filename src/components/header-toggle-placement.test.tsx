import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionHeader } from './mobile-session-header'
import { PcSessionTabBar } from './pc-tab-bar'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string) => key,
}))

describe('header toggle placement', () => {
  it('does not render workspace toggle inside the pc session tab bar', () => {
    render(
      <PcSessionTabBar
        sessionTabs={[
          { sessionId: 'session-1', hostName: 'OpenClaw-KK', hostAddress: '164.68.124.173', status: 'connected' },
        ]}
        activeSessionId="session-1"
        isDashboard={false}
        isSplit={false}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
        onGoToDashboard={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'workspace.mode.terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.mode.workspace' })).not.toBeInTheDocument()
  })

  it('does not render workspace toggle inside the mobile session header', () => {
    render(
      <MobileSessionHeader
        sessionTabs={[
          { sessionId: 'session-1', hostName: 'OpenClaw-KK', hostAddress: '164.68.124.173', status: 'connected' },
        ]}
        activeSessionId="session-1"
        onSelectSession={() => {}}
        onCloseSession={() => {}}
        onNewConnection={() => {}}
        onOpenLocalTerminal={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'workspace.mode.terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.mode.workspace' })).not.toBeInTheDocument()
  })
})
