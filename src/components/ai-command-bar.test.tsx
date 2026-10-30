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
/** Lets a run settle, then lets the deferred automatic continue go out. */
const settle = (bridge: { emit: () => void }) => { act(() => { bridge.emit(); vi.advanceTimersByTime(1300) }); act(() => { vi.advanceTimersByTime(1) }) }
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
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear conversation' }))
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
    expect(screen.getByRole('dialog', { name: 'Server info' })).toHaveTextContent('os: Ubuntu 24.04')
    fireEvent.click(screen.getByRole('switch', { name: 'Send with each message' }))
    expect(screen.getByRole('switch', { name: 'Send with each message' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Generate command' }))
    expect(lastHost).toBe('')
  })

  it('suggests requests from the asset scan, offers the probe, and clears the screen from the menu', () => {
    const bridge = { ...fakeBridge(''), clear: vi.fn() }
    const onInstall = vi.fn()
    const inventory = {
      resource: { hostname: 'web', os: 'Ubuntu', kernel: '', uptime: '', cpuPercent: 3, memoryPercent: 40, memoryText: '', diskPercent: 91, diskText: '', network: '' },
      tools: [{ id: 'nginx', name: 'nginx', category: 'web', binary: 'nginx', path: '', version: '1.24' }],
      services: [], containers: [], pm2: [], projects: [], scannedAt: 1,
    }
    render(<AICommandBar {...base} bridge={bridge} inventory={inventory} memoryKey="v1:root@10.0.0.7" probe={{ onInstall }} />)
    expect(screen.getByTestId('ai-smart-suggestions')).toHaveTextContent('Disk is 91% full')
    expect(screen.getByTestId('ai-smart-suggestions')).toHaveTextContent('Test the nginx config')
    expect(screen.getByTestId('ai-examples')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install probe' }))
    expect(onInstall).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('ai-probe-offer')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Clear conversation' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Install ShellBeam probe' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear terminal screen' }))
    expect(bridge.clear).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText(/Disk is 91% full/))
    expect(streamAICommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Disk is 91% full'), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), 'confirm')
  })

  it('asks before turning on continuous run and keeps the default until confirmed', () => {
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.8" />)
    expect(screen.getByTestId('ai-run-mode')).toHaveAttribute('data-mode', 'confirm')
    fireEvent.click(screen.getByTestId('ai-run-mode'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Run continuously/ }))
    expect(screen.getByTestId('ai-auto-warning')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('ai-run-mode')).toHaveAttribute('data-mode', 'confirm')
    fireEvent.click(screen.getByTestId('ai-run-mode'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Run continuously/ }))
    fireEvent.click(screen.getByRole('button', { name: 'I understand, turn it on' }))
    expect(screen.getByTestId('ai-run-mode')).toHaveAttribute('data-mode', 'auto')
    expect(localStorage.getItem('shellbeam.aiRunMode.v1:root@10.0.0.8')).toBe('auto')
  })

  it('runs read-only checks by itself, waits on changes, and stops when AI is done', () => {
    vi.useFakeTimers()
    localStorage.setItem('shellbeam.aiRunMode.k', 'read-only')
    const bridge = fakeBridge('/ 91%')
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)
    ask('disk is full'); act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    expect(bridge.run).toHaveBeenCalledExactlyOnceWith('df -h')
    settle(bridge)
    expect(screen.getByTestId('ai-auto-continue')).toBeInTheDocument()
    expect(lastHistory).toContainEqual({ role: 'output', content: '$ df -h\n/ 91%' })
    act(() => { callbacks.onToken('sudo journalctl --vacuum-time=7d'); callbacks.onDone() })
    expect(bridge.run).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'waiting')
    fireEvent.click(screen.getAllByRole('button', { name: 'Run' }).at(-1)!)
    expect(bridge.run).toHaveBeenLastCalledWith('sudo journalctl --vacuum-time=7d')
    settle(bridge)
    expect(screen.getAllByTestId('ai-auto-continue')).toHaveLength(2)
    act(() => { callbacks.onToken('# Freed 2 GB.'); callbacks.onDone() })
    expect(screen.queryByTestId('ai-auto-status')).not.toBeInTheDocument()
  })

  it('never auto-runs destructive commands, stops on a question, and pauses after the step limit', () => {
    vi.useFakeTimers()
    localStorage.setItem('shellbeam.aiRunMode.k', 'auto')
    const bridge = fakeBridge('ok')
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)
    ask('clean up'); act(() => { callbacks.onToken('rm -rf /var/www/old'); callbacks.onDone() })
    expect(bridge.run).not.toHaveBeenCalled()
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'waiting')
    ask('which site?'); act(() => { callbacks.onToken('#? Which site should I reload?\n#- a.com\n#- b.com'); callbacks.onDone() })
    expect(screen.getByTestId('ai-question')).toHaveTextContent('Which site should I reload?')
    expect(screen.queryByTestId('ai-auto-status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'b.com' }))
    for (let step = 1; step <= 10; step++) {
      act(() => { callbacks.onToken(`echo ${step}`); callbacks.onDone() })
      settle(bridge)
    }
    expect(bridge.run).toHaveBeenCalledTimes(10)
    act(() => { callbacks.onToken('echo 11'); callbacks.onDone() })
    expect(bridge.run).toHaveBeenCalledTimes(10)
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'limit')
    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }))
    expect(bridge.run).toHaveBeenLastCalledWith('echo 11')
  })

  it('stops the automatic run when a command is still printing at the capture limit', () => {
    vi.useFakeTimers()
    localStorage.setItem('shellbeam.aiRunMode.k', 'auto')
    const bridge = fakeBridge('Do you want to continue? [Y/n]')
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)
    ask('upgrade'); act(() => { callbacks.onToken('sudo apt upgrade'); callbacks.onDone() })
    for (let i = 0; i < 25; i++) act(() => { bridge.emit(); vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'unsettled')
    expect(screen.queryByTestId('ai-auto-continue')).not.toBeInTheDocument()
  })

  it('waits for the prompt to come back, shows live output, and marks the card with the outcome', () => {
    vi.useFakeTimers()
    let status: 'busy' | 'prompt' | 'input' = 'busy'
    let output = ''
    const listeners = new Set<() => void>()
    const bridge: TerminalAiBridge = {
      run: vi.fn(() => ({ read: () => output, status: () => status, onOutput: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }, dispose: vi.fn() })),
      insert: vi.fn(), recentOutput: () => '', interrupt: vi.fn(),
    }
    const write = (text: string) => act(() => { output += text; listeners.forEach((l) => l()) })
    render(<AICommandBar {...base} bridge={bridge} />)
    ask(); act(() => { callbacks.onToken('sudo apt-get install -y nginx'); callbacks.onDone() })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    write('Reading package lists...')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('ai-run')).toHaveTextContent('Reading package lists...')
    expect(screen.getByTestId('ai-card-run')).toHaveAttribute('data-state', 'running')
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }))
    expect(bridge.interrupt).toHaveBeenCalledOnce()
    write('\nDone'); status = 'prompt'
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-outcome', 'ok')
    expect(screen.getByTestId('ai-card-run')).toHaveTextContent('Run by you')
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument()
  })

  it('stops the automatic run when a command asks a question', () => {
    vi.useFakeTimers()
    localStorage.setItem('shellbeam.aiRunMode.k', 'auto')
    const bridge: TerminalAiBridge = {
      run: vi.fn(() => ({ read: () => 'Do you want to continue? [Y/n]', status: () => 'input' as const, onOutput: () => () => {}, dispose: vi.fn() })),
      insert: vi.fn(), recentOutput: () => '',
    }
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)
    ask('upgrade'); act(() => { callbacks.onToken('sudo apt upgrade'); callbacks.onDone() })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-outcome', 'input')
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'input')
    expect(screen.getByTestId('ai-card-run')).toHaveTextContent('Run by AI')
  })

  it('restarts the step budget when the user runs a command during an automatic run', () => {
    vi.useFakeTimers()
    localStorage.setItem('shellbeam.aiRunMode.k', 'auto')
    const bridge = fakeBridge('ok')
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)
    ask('loop')
    for (let step = 1; step <= 10; step++) {
      act(() => { callbacks.onToken(`echo ${step}`); callbacks.onDone() })
      settle(bridge)
    }
    act(() => { callbacks.onToken('echo 11'); callbacks.onDone() })
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'limit')
    fireEvent.click(screen.getAllByRole('button', { name: 'Run' }).at(-1)!)
    settle(bridge)
    act(() => { callbacks.onToken('echo 12'); callbacks.onDone() })
    expect(bridge.run).toHaveBeenLastCalledWith('echo 12')
    expect(screen.getByTestId('ai-auto-status')).toHaveAttribute('data-status', 'running')
  })

  it('offers a retry after an error', () => {
    render(<AICommandBar {...base} />)
    ask('disk usage'); act(() => callbacks.onError('network down'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(streamAICommand).toHaveBeenCalledTimes(2)
    expect(vi.mocked(streamAICommand).mock.calls[1][1]).toBe('disk usage')
  })
})
