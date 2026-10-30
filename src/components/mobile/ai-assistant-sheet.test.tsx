import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamAICommand, type AIStreamCallbacks } from '@/lib/ai'
import { AICommandBar } from '../ai-command-bar'

vi.mock('@/lib/ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ai')>(),
  streamAICommand: vi.fn(), loadAISettings: () => ({ backend: 'codex-cli' }), isAIConfigured: () => true,
}))
let callbacks!: AIStreamCallbacks
beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks()
  vi.mocked(streamAICommand).mockImplementation(async (_settings, _prompt, _context, cb) => { callbacks = cb })
})
afterEach(cleanup)

function ask(reply: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'why is nginx down' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate command' }))
  act(() => { callbacks.onToken(reply); callbacks.onDone() })
}

describe('AI assistant bottom sheet', () => {
  it('shows runnable command cards with a risk label and only runs on an explicit tap', () => {
    const execute = vi.fn()
    render(<AICommandBar presentation="sheet" contextLabel="prod-web-01" visible onClose={vi.fn()} getTerminalContext={() => ''} onExecuteCommand={execute} />)
    expect(screen.getByRole('dialog', { name: 'AI assistant' })).toBeInTheDocument()
    expect(screen.getByText('prod-web-01')).toBeInTheDocument()
    ask('sudo nginx -t && \\\nsudo journalctl -u nginx -n 20 --no-pager')
    expect(execute).not.toHaveBeenCalled()
    expect(screen.getByTestId('command-risk')).toHaveAttribute('data-risk', 'read-only')
    expect(screen.getByText('Read-only command, will not modify the server')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(execute).toHaveBeenCalledExactlyOnceWith('sudo nginx -t && \\\nsudo journalctl -u nginx -n 20 --no-pager\n')
  })

  it('lets the command be edited before running and re-labels its risk', () => {
    const execute = vi.fn()
    render(<AICommandBar presentation="sheet" visible onClose={vi.fn()} getTerminalContext={() => ''} onExecuteCommand={execute} />)
    ask('ls /tmp')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Editing command' }), { target: { value: 'rm -rf /tmp/cache' } })
    expect(screen.getByTestId('command-risk')).toHaveAttribute('data-risk', 'destructive')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(execute).toHaveBeenCalledExactlyOnceWith('rm -rf /tmp/cache\n')
  })

  it('closes from the Done button', () => {
    const onClose = vi.fn()
    render(<AICommandBar presentation="sheet" visible onClose={onClose} getTerminalContext={() => ''} onExecuteCommand={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('AI risk label on desktop', () => {
  it('shows a compact chip next to the inline command actions', () => {
    render(<AICommandBar presentation="inline" visible onClose={vi.fn()} getTerminalContext={() => ''} onExecuteCommand={vi.fn()} />)
    ask('systemctl restart nginx')
    expect(screen.getByTestId('command-risk')).toHaveAttribute('data-risk', 'changes-state')
    expect(screen.getByText('Changes state')).toBeInTheDocument()
  })
})
