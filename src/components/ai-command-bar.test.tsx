import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AICommandBar } from './ai-command-bar'
import { streamAICommand, type AISettings, type AIStreamCallbacks } from '@/lib/ai'
import type { TerminalAiBridge } from '@/lib/ai-conversation'

vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>()
  return { ...actual, streamAICommand: vi.fn(), isAIConfigured: () => true }
})
let callbacks!: AIStreamCallbacks; let signal: AbortSignal | undefined
let lastHistory: unknown[] = []; let lastHost = ''
const codex: AISettings = { backend: 'codex-cli', provider: 'openai', apiKey: '', model: '', customBaseUrl: '', customModel: '' }
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('shellbeam.locale', 'en')
  localStorage.setItem('shellbeam.aiSettings', JSON.stringify(codex))
  vi.clearAllMocks()
  vi.mocked(streamAICommand).mockImplementation(async (_settings, _prompt, _context, cb, s, history, host) => { callbacks = cb; signal = s; lastHistory = history ?? []; lastHost = host ?? '' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const ask = (text = 'show current directory') => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe what you want to do…' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate command' }))
}
function fakeBridge(output: string) {
  const listeners = new Set<() => void>()
  const bridge: TerminalAiBridge & { emit: () => void } = {
    run: vi.fn(() => ({ read: () => output, onOutput: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, dispose: vi.fn() })),
    insert: vi.fn(),
    recentOutput: vi.fn(() => 'recent'),
    emit: () => listeners.forEach((listener) => listener()),
  }
  return bridge
}
const base = { onExecuteCommand: vi.fn(), getTerminalContext: () => '', visible: true, onClose: vi.fn(), presentation: 'inline' as const }

describe('AICommandBar', () => {
  it('only runs a completed command after an explicit Run click, then shares the captured output', () => {
    vi.useFakeTimers()
    const bridge = fakeBridge('/home/app\n')
    render(<AICommandBar {...base} bridge={bridge} />)
    ask(); act(() => callbacks.onToken('pwd'))
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    act(() => callbacks.onDone())
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(bridge.run).toHaveBeenCalledExactlyOnceWith('pwd')
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-state', 'running')
    act(() => { bridge.emit(); vi.advanceTimersByTime(1300) })
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-state', 'captured')
    expect(screen.getByText(/Output · 1 lines/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Explain the output' }))
    expect(lastHistory).toEqual([
      { role: 'user', content: 'show current directory' },
      { role: 'assistant', content: 'pwd' },
      { role: 'output', content: '$ pwd\n/home/app' },
    ])
  })

  it('offers a fix when the output looks like a failure, and Insert types without running', () => {
    vi.useFakeTimers()
    const bridge = fakeBridge('bash: ngnix: command not found')
    render(<AICommandBar {...base} bridge={bridge} />)
    ask(); act(() => { callbacks.onToken('ngnix -t'); callbacks.onDone() })
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(bridge.insert).toHaveBeenCalledWith('ngnix -t'); expect(bridge.run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    act(() => { vi.advanceTimersByTime(1300) })
    expect(screen.getByRole('button', { name: 'Fix the error' })).toBeInTheDocument()
  })

  it('shows a "# " reply as an answer that cannot be run', () => {
    render(<AICommandBar {...base} />)
    ask('is the disk full?'); act(() => { callbacks.onToken('# No, / is 41% used.'); callbacks.onDone() })
    expect(screen.getByTestId('ai-note')).toHaveTextContent('No, / is 41% used.')
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
  })

  it('discards partial output on cancel and prevents late callbacks from completing another request', () => {
    render(<AICommandBar {...base} />)
    ask(); const old = callbacks; act(() => old.onToken('rm '))
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' })); expect(signal?.aborted).toBe(true)
    ask(); act(() => { old.onToken('-rf /'); old.onDone(); callbacks.onToken('pwd'); callbacks.onDone() })
    expect(screen.queryByText('rm -rf /')).not.toBeInTheDocument()
    expect(screen.getByText('pwd')).toBeInTheDocument()
  })

  it('aborts when hidden or unmounted and never makes failed output executable', () => {
    const view = render(<AICommandBar {...base} />); ask()
    act(() => { callbacks.onToken('partial'); callbacks.onError('failed') })
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('failed')
    ask(); view.rerender(<AICommandBar {...base} visible={false} />)
    expect(signal?.aborted).toBe(true)
    view.rerender(<AICommandBar {...base} />); ask(); view.unmount(); expect(signal?.aborted).toBe(true)
  })

  it('shows the model in use, records the reported one, and switches backend without clearing the chat', () => {
    render(<AICommandBar {...base} />)
    expect(screen.getByTestId('ai-model-switcher')).toHaveTextContent('Codex CLI')
    expect(screen.getByTestId('ai-model-switcher')).toHaveTextContent('CLI default')
    ask(); act(() => { callbacks.onModel?.('gpt-5.5'); callbacks.onToken('pwd'); callbacks.onDone() })
    expect(screen.getByTestId('ai-model-switcher')).toHaveTextContent('gpt-5.5')
    expect(screen.getByText(/gpt-5\.5 · /)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ai-model-switcher'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: 'opus' }))
    const saved = JSON.parse(localStorage.getItem('shellbeam.aiSettings')!) as AISettings
    expect(saved.backend).toBe('claude-code')
    expect(saved.cliProfiles?.['claude-code']?.model).toBe('opus')
    expect(screen.getByTestId('ai-model-switcher')).toHaveTextContent('Claude Code')
    expect(screen.getByText('pwd')).toBeInTheDocument()
  })

  it('shows a leading "# " line as the caption and runs only the command', () => {
    const bridge = fakeBridge('')
    render(<AICommandBar {...base} bridge={bridge} />)
    ask(); act(() => { callbacks.onToken('# List listening ports\nss -tlnp'); callbacks.onDone() })
    expect(screen.getByTestId('ai-caption')).toHaveTextContent('List listening ports')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(bridge.run).toHaveBeenCalledExactlyOnceWith('ss -tlnp')
  })

  it('remembers the conversation per host and sends host facts', () => {
    const first = render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.5" hostFacts={[{ key: 'os', value: 'Ubuntu 24.04' }]} />)
    ask('disk usage'); act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    expect(lastHost).toBe('os: Ubuntu 24.04')
    first.unmount()
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.5" />)
    expect(screen.getByText('df -h')).toBeInTheDocument()
    expect(screen.getByText(/Continued from/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(screen.queryByText('df -h')).not.toBeInTheDocument()
    expect(localStorage.getItem('shellbeam.aiConversation.v1:root@10.0.0.5')).toBeNull()
    cleanup()
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.6" />)
    expect(screen.queryByText('df -h')).not.toBeInTheDocument()
  })

  it('offers the suggested next step in the empty input and fills it with Tab', () => {
    render(<AICommandBar {...base} hostFacts={[{ key: 'os', value: 'Ubuntu 24.04' }]} />)
    expect(screen.getByTestId('ai-host-facts')).toHaveTextContent('Ubuntu 24.04')
    ask(); act(() => { callbacks.onToken('df -h\n#> Find what fills the disk'); callbacks.onDone() })
    expect(screen.getByText('df -h')).toBeInTheDocument()
    expect(screen.queryByText(/#>/)).not.toBeInTheDocument()
    expect(screen.getByTestId('ai-next-tip')).toHaveTextContent('Find what fills the disk')
    const box = screen.getByRole('textbox', { name: 'Describe what you want to do…' })
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(box).toHaveValue('Find what fills the disk')
    expect(screen.queryByTestId('ai-next-tip')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Server info' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate command' }))
    expect(lastHost).toBe('')
  })
})

