import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import { CommandPalette } from './command-palette'

vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))

const host = (id: string, name: string, address: string) => ({ id, vaultId: 'v', name, address, port: 22, username: 'root', group: 'p', authType: 'privateKey', tags: [], createdAt: 1, updatedAt: 1 }) as HostProfile
const hosts = [host('a', 'prod-web-01', '47.242.18.6'), host('b', 'prod-web-02', '47.242.18.7'), host('c', 'db-master', '10.0.3.12')]

describe('CommandPalette', () => {
  beforeEach(() => localStorage.setItem('shellbeam.locale', 'en'))

  const setup = () => {
    const props = { onClose: vi.fn(), onSelectHost: vi.fn(), onAction: vi.fn(), onHostAction: vi.fn(), onToggleTheme: vi.fn() }
    render(<CommandPalette open hosts={hosts} historyEntries={[]} selectedHostId={null} {...props} />)
    return props
  }

  it('lists hosts first, then quick actions for the top match, then commands', () => {
    setup()
    expect(screen.getAllByTestId('command-palette-host')).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'db' } })
    expect(screen.getAllByTestId('command-palette-host')).toHaveLength(1)
    expect(screen.getByTestId('command-palette-quick-sftp')).toHaveTextContent('Open SFTP on db-master')
  })

  it('connects with Enter on the active host and runs quick actions for that host', () => {
    const props = setup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'prod-web-02' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(props.onSelectHost).toHaveBeenCalledWith('b')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('routes quick actions, commands and the theme toggle', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('command-palette-quick-workspace'))
    expect(props.onHostAction).toHaveBeenCalledWith('a', 'workspace')
    fireEvent.click(screen.getByTestId('command-palette-action-focus-settings'))
    expect(props.onAction).toHaveBeenCalledWith('focus-settings')
    fireEvent.click(screen.getByTestId('command-palette-action-theme'))
    expect(props.onToggleTheme).toHaveBeenCalled()
  })
})
