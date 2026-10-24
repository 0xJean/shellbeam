import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AICommandBar } from './ai-command-bar'
import { streamAICommand, type AIStreamCallbacks } from '@/lib/ai'
vi.mock('@/lib/ai', () => ({ streamAICommand: vi.fn(), loadAISettings: () => ({ backend: 'codex-cli' }), isAIConfigured: () => true, createAbortController: () => new AbortController() }))
let callbacks!: AIStreamCallbacks; let signal: AbortSignal | undefined
beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks()
  vi.mocked(streamAICommand).mockImplementation(async (_settings, _prompt, _context, cb, s) => { callbacks = cb; signal = s })
})
afterEach(cleanup)
const submit = () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'show current directory' } }); fireEvent.click(screen.getByRole('button', { name: 'Generate command' })) }
describe('terminal command review', () => {
  it('only executes a completed command after an explicit Run click', async () => {
    const execute = vi.fn(); render(<AICommandBar visible onClose={vi.fn()} getTerminalContext={() => 'remote context'} onExecuteCommand={execute} />)
    submit(); act(() => callbacks.onToken('pwd'))
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument(); expect(execute).not.toHaveBeenCalled()
    act(() => callbacks.onDone())
    fireEvent.click(screen.getByRole('button', { name: 'Run' })); expect(execute).toHaveBeenCalledExactlyOnceWith('pwd\n')
  })
  it('discards partial output on cancel and prevents late callbacks from completing another request', () => {
    render(<AICommandBar visible onClose={vi.fn()} getTerminalContext={() => ''} onExecuteCommand={vi.fn()} />)
    submit(); const old = callbacks; act(() => old.onToken('rm '))
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' })); expect(signal?.aborted).toBe(true)
    submit(); act(() => { old.onToken('-rf /'); old.onDone(); callbacks.onToken('pwd'); callbacks.onDone() })
    expect(screen.queryByText('rm -rf /')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Run' })).toHaveLength(1)
  })
  it('aborts when hidden or unmounted and never makes failed output executable', () => {
    const props = { visible: true, onClose: vi.fn(), getTerminalContext: () => '', onExecuteCommand: vi.fn() }
    const view = render(<AICommandBar {...props} />); submit()
    act(() => { callbacks.onToken('partial'); callbacks.onError('CLI failed') })
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    submit(); const old = callbacks; view.rerender(<AICommandBar {...props} visible={false} />)
    expect(signal?.aborted).toBe(true); act(() => old.onDone())
    view.rerender(<AICommandBar {...props} />); expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    submit(); view.unmount(); expect(signal?.aborted).toBe(true)
  })
})
