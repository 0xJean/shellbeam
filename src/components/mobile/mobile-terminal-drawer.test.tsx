import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordInteractiveCommand } from '@/lib/interactive-history'
import { DEFAULT_TERMINAL_PREFS, TERMINAL_THEMES } from '@/lib/terminal-themes'
import type { SnippetEntry } from '@/lib/snippets'
import { MobileTerminalDrawer } from './mobile-terminal-drawer'

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })
afterEach(cleanup)

const snippets: SnippetEntry[] = [
  { id: 'a', name: 'Restart nginx', command: 'sudo systemctl restart nginx', tags: [], createdAt: 1, updatedAt: 1 },
  { id: 'b', name: 'Disk top 10', command: 'du -sh /* | sort -rh | head', tags: [], createdAt: 1, updatedAt: 1 },
]

function setup() {
  const props = {
    visible: true, onClose: vi.fn(), hostAddress: '10.9.9.9', snippets, onApplySnippet: vi.fn(), onRunSnippet: vi.fn(),
    terminalPrefs: { ...DEFAULT_TERMINAL_PREFS, fontSize: 12 }, onTerminalPrefsChange: vi.fn(), onSearchToggle: vi.fn(), searchVisible: false,
    hosts: [{ id: 'h', name: 'prod-web-01', address: '10.9.9.9' }] as never, vaultId: 'vault-a',
  }
  render(<MobileTerminalDrawer {...props} />)
  return props
}

describe('MobileTerminalDrawer', () => {
  it('pastes or runs snippets and filters them', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Paste Restart nginx' }))
    expect(props.onApplySnippet).toHaveBeenCalledWith('sudo systemctl restart nginx')
    fireEvent.click(screen.getByRole('button', { name: 'Run Disk top 10' }))
    expect(props.onRunSnippet).toHaveBeenCalledWith('du -sh /* | sort -rh | head')
    fireEvent.change(screen.getByPlaceholderText('Search snippets…'), { target: { value: 'disk' } })
    expect(screen.queryByText('Restart nginx')).not.toBeInTheDocument()
  })

  it('lists typed history for the host and runs an entry', async () => {
    recordInteractiveCommand('vault-a', '10.9.9.9', 'df -h /')
    recordInteractiveCommand('vault-b', '10.9.9.9', 'cat /etc/other-vault')
    const props = setup()
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByText('prod-web-01 · keeps up to 200')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Run df -h /' }))
    expect(props.onRunSnippet).toHaveBeenCalledWith('df -h /')
    expect(screen.queryByText('cat /etc/other-vault')).not.toBeInTheDocument()
  })

  it('changes font size and colour scheme', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Look' }))
    fireEvent.click(screen.getByRole('button', { name: 'Larger' }))
    expect(props.onTerminalPrefsChange).toHaveBeenCalledWith({ fontSize: 13 })
    const theme = TERMINAL_THEMES.find((entry) => entry.id !== DEFAULT_TERMINAL_PREFS.themeId)!
    fireEvent.click(screen.getByRole('button', { name: theme.name }))
    expect(props.onTerminalPrefsChange).toHaveBeenLastCalledWith({ themeId: theme.id })
  })
})
