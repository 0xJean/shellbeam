import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AICommandBar } from './ai-command-bar'
import { streamAICommand, type AISettings, type AIStreamCallbacks } from '@/lib/ai'
import type { TerminalAiBridge } from '@/lib/ai-conversation'
import { vaultSealData } from '@/lib/vault'

vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>()
  return { ...actual, streamAICommand: vi.fn(), isAIConfigured: () => true }
})
vi.mock('@/lib/vault', () => ({
  // A reversible stand-in for the Vault seal: opaque text, bound to its Vault and context.
  vaultSealData: vi.fn(async (_purpose: string, context: string, plaintext: string, vaultId?: string | null) => `sealed:${btoa(encodeURIComponent(JSON.stringify([vaultId, context, plaintext])))}`),
  vaultOpenData: vi.fn(async (_purpose: string, context: string, sealed: string, vaultId?: string | null) => {
    const [sealedVault, sealedContext, plaintext] = JSON.parse(decodeURIComponent(atob(sealed.slice('sealed:'.length)))) as string[]
    if (sealedVault !== vaultId || sealedContext !== context) throw new Error('does not open')
    return plaintext
  }),
}))
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

  it('scrolls to the latest message when the panel opens', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const view = render(<AICommandBar {...base} visible={false} />)
    view.rerender(<AICommandBar {...base} />)
    const scroller = [...view.container.querySelectorAll<HTMLElement>('.overflow-y-auto')].find((element) => element.scrollTop === 900)
    expect(scroller).toBeTruthy()
    height.mockRestore()
  })

  it('keeps following content that appears after opening, until the user scrolls up', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const view = render(<AICommandBar {...base} />)
    const scroller = [...view.container.querySelectorAll<HTMLElement>('.overflow-y-auto')].find((element) => element.scrollTop === 900) as HTMLElement
    height.mockReturnValue(1200)
    await act(async () => { scroller.appendChild(document.createElement('div')); await Promise.resolve() })
    expect(scroller.scrollTop).toBe(1200)
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    height.mockReturnValue(1500)
    await act(async () => { scroller.appendChild(document.createElement('div')); await Promise.resolve() })
    expect(scroller.scrollTop).toBe(100)
    height.mockRestore()
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

  it('remembers the conversation per host, sealed by its Vault, and sends host facts', async () => {
    const first = render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.5" memoryVaultId="v1" hostFacts={[{ key: 'os', value: 'Ubuntu 24.04' }]} />)
    await act(async () => { await Promise.resolve() })
    ask('disk usage'); act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    expect(lastHost).toBe('os: Ubuntu 24.04')
    await waitFor(() => expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@10.0.0.5')).toMatch(/^sealed:/))
    expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@10.0.0.5')).not.toContain('df -h')
    expect(localStorage.getItem('shellbeam.aiConversation.v1:root@10.0.0.5')).toBeNull()
    first.unmount()
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.5" memoryVaultId="v1" />)
    expect(await screen.findByText('df -h')).toBeInTheDocument()
    expect(screen.getByText(/Continued from/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear conversation' }))
    expect(screen.queryByText('df -h')).not.toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@10.0.0.5')).toBeNull())
    cleanup()
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.6" memoryVaultId="v1" />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('df -h')).not.toBeInTheDocument()
  })

  it('moves a plain-text conversation from an older release under the Vault seal', async () => {
    const legacy = { savedAt: 1_700_000_000_000, turns: [{ kind: 'user', id: 'u1', text: 'who is logged in' }, { kind: 'ai', id: 'a1', text: 'who', model: 'm' }] }
    localStorage.setItem('shellbeam.aiConversation.v1:root@10.0.0.9', JSON.stringify(legacy))
    render(<AICommandBar {...base} memoryKey="v1:root@10.0.0.9" memoryVaultId="v1" />)
    expect(await screen.findByText('who is logged in')).toBeInTheDocument()
    await waitFor(() => expect(localStorage.getItem('shellbeam.aiConversation.v1:root@10.0.0.9')).toBeNull())
    expect(localStorage.getItem('shellbeam.aiConversationSealed.v1:root@10.0.0.9')).toMatch(/^sealed:/)
  })

  it('keeps nothing without a Vault to seal the conversation', async () => {
    render(<AICommandBar {...base} memoryKey="none:root@10.0.0.5" memoryVaultId={null} />)
    ask('disk usage'); act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    await act(async () => { await Promise.resolve() })
    expect(vi.mocked(vaultSealData)).not.toHaveBeenCalled()
    expect(Object.keys(localStorage).filter((name) => name.includes('aiConversation'))).toEqual([])
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

  it('runs bounded read-only checks silently via SSH exec with real exit codes and no false error on grep output', async () => {
    const exec = vi.fn(async () => ({ stdout: '2026-11-21 error connection reset\n', stderr: '', exitCode: 0, durationMs: 42 }))
    const bridge = { ...fakeBridge('terminal-output'), exec }
    render(<AICommandBar {...base} bridge={bridge} />)
    ask('check app errors'); act(() => { callbacks.onToken('grep error /var/log/app.log'); callbacks.onDone() })

    expect(screen.getByTestId('ai-run-in-terminal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(screen.getByTestId('ai-run')).toHaveAttribute('data-state', 'captured'))
    expect(exec).toHaveBeenCalledExactlyOnceWith('grep error /var/log/app.log')
    expect(bridge.run).not.toHaveBeenCalled()
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-via', 'exec')
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-outcome', 'ok')
    expect(screen.getByTestId('ai-run')).toHaveTextContent('exit 0')
    expect(screen.queryByRole('button', { name: 'Fix the error' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Explain the output' }))
    expect(lastHistory).toContainEqual({
      role: 'output',
      content: '$ grep error /var/log/app.log\n[exit code: 0]\n2026-11-21 error connection reset',
    })
  })

  it('auto-continues read-only checks silently, supports explicit Run in terminal, and falls back on auth errors', async () => {
    localStorage.setItem('shellbeam.aiRunMode.k', 'read-only')
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: 'COMMIT count=12 max_ms=820.5\n', stderr: '', exitCode: 0, durationMs: 35 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'vault locked', exitCode: -1, durationMs: 5, errorType: 'auth' })
    const bridge = { ...fakeBridge('from-terminal'), exec }
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k" />)

    ask('check slow sql')
    act(() => {
      callbacks.onToken(`docker logs --since 24h pg 2>&1 | awk '{c++} END{print c}'`)
      callbacks.onDone()
    })

    await waitFor(() => expect(screen.getByTestId('ai-auto-continue')).toBeInTheDocument())
    expect(exec).toHaveBeenCalledTimes(1)
    expect(bridge.run).not.toHaveBeenCalled()
    expect(lastHistory).toContainEqual({
      role: 'output',
      content: "$ docker logs --since 24h pg 2>&1 | awk '{c++} END{print c}'\n[exit code: 0]\nCOMMIT count=12 max_ms=820.5",
    })

    // Second read-only step returns auth error from exec -> falls back seamlessly to interactive terminal
    act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    await waitFor(() => expect(bridge.run).toHaveBeenCalledWith('df -h'))

    // Explicit Terminal button on the first card forces interactive terminal execution
    fireEvent.click(screen.getAllByTestId('ai-run-in-terminal')[0])
    expect(bridge.run).toHaveBeenLastCalledWith(`docker logs --since 24h pg 2>&1 | awk '{c++} END{print c}'`)
  })

  it('routes sudo and state-changing commands to the interactive terminal even when exec is available', () => {
    const exec = vi.fn()
    const bridge = { ...fakeBridge('ok'), exec }
    render(<AICommandBar {...base} bridge={bridge} />)
    ask('test nginx'); act(() => { callbacks.onToken('sudo nginx -t'); callbacks.onDone() })
    expect(screen.queryByTestId('ai-run-in-terminal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(exec).not.toHaveBeenCalled()
    expect(bridge.run).toHaveBeenCalledExactlyOnceWith('sudo nginx -t')
  })

  it('renders Markdown tables in note replies, lets Codex pick preset models & reasoning effort, and supports multi-thread history & attached excerpts', async () => {
    const onClearAttachedSnippet = vi.fn()
    render(
      <AICommandBar
        {...base}
        memoryKey="v1:root@10.0.0.50"
        memoryVaultId="v1"
        attachedSnippet={'LOG: duration: 920 ms\nSELECT * FROM orders'}
        onClearAttachedSnippet={onClearAttachedSnippet}
      />,
    )
    await act(async () => { await Promise.resolve() })

    // Codex CLI switcher now exposes preset models, Gemini CLI / OpenCode backends, and reasoning effort
    fireEvent.click(screen.getByTestId('ai-model-switcher'))
    expect(screen.getByRole('menuitemradio', { name: 'Gemini CLI' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'OpenCode' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'gpt-6.2-sol' }))
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    const saved = JSON.parse(localStorage.getItem('shellbeam.aiSettings')!) as AISettings
    expect(saved.cliProfiles?.['codex-cli']?.model).toBe('gpt-6.2-sol')
    expect(saved.cliProfiles?.['codex-cli']?.effort).toBe('high')
    fireEvent.keyDown(window, { key: 'Escape' })

    // Attached terminal selection appears as a chip and is sent with the request
    expect(screen.getByTestId('ai-attached-snippet')).toHaveTextContent('Selected 2 lines')
    ask('summarize slow sql')
    expect(onClearAttachedSnippet).toHaveBeenCalledOnce()
    act(() => {
      callbacks.onToken('# ## Slow SQL Summary\n# | Type | Count |\n# | --- | --- |\n# | COMMIT | 12 |')
      callbacks.onDone()
    })
    expect(screen.getByTestId('ai-note').querySelector('table')).not.toBeNull()
    expect(screen.getByTestId('ai-note')).toHaveTextContent('COMMIT')

    // Start a new thread while preserving the first conversation in History
    fireEvent.click(screen.getByTestId('ai-new-thread'))
    expect(screen.queryByTestId('ai-note')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ai-thread-history'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Conversations' })).toHaveTextContent('summarize slow sql'))
  })

  it('preserves conversations from two open terminals on the same host without overwriting each other', async () => {
    const memoryKey = 'v1:root@10.0.0.88'
    render(
      <div>
        <div data-testid="terminal-panel-a">
          <AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" />
        </div>
        <div data-testid="terminal-panel-b">
          <AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" />
        </div>
      </div>,
    )
    await act(async () => { await Promise.resolve() })

    const inputs = screen.getAllByRole('textbox', { name: 'Describe what you want to do…' })
    const submitButtons = screen.getAllByRole('button', { name: 'Generate command' })

    // Terminal A saves its thread first
    fireEvent.change(inputs[0], { target: { value: 'check postgres locks' } })
    fireEvent.click(submitButtons[0])
    act(() => { callbacks.onToken('# No deadlocks found.'); callbacks.onDone() })

    // Terminal B still only knew about its own empty state when mounted, then saves its own thread
    fireEvent.change(inputs[1], { target: { value: 'check nginx upstream' } })
    fireEvent.click(submitButtons[1])
    act(() => { callbacks.onToken('# Upstream healthy.'); callbacks.onDone() })

    // Opening History in Terminal B must show BOTH Terminal A's and Terminal B's threads
    const historyButtons = screen.getAllByTestId('ai-thread-history')
    fireEvent.click(historyButtons[1])
    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: 'Conversations' })
      expect(dialog).toHaveTextContent('check postgres locks')
      expect(dialog).toHaveTextContent('check nginx upstream')
    })
  })

  it('forks shared-thread follow-ups across two terminals, preserves >30-turn in-session history, and clears deleted sole threads on refresh', async () => {
    const memoryKey = 'v1:root@10.0.0.99'
    render(
      <div>
        <div data-testid="shared-a"><AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" /></div>
        <div data-testid="shared-b"><AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" /></div>
      </div>,
    )
    await act(async () => { await Promise.resolve() })

    const inputs = screen.getAllByRole('textbox', { name: 'Describe what you want to do…' })
    const submitButtons = screen.getAllByRole('button', { name: 'Generate command' })
    const historyButtons = screen.getAllByTestId('ai-thread-history')

    // 1. Start a conversation in Terminal A, then select that exact conversation in Terminal B.
    fireEvent.change(inputs[0], { target: { value: 'shared incident' } })
    fireEvent.click(submitButtons[0])
    act(() => { callbacks.onToken('# Initial triage complete.'); callbacks.onDone() })

    fireEvent.click(historyButtons[1])
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Conversations' })).toHaveTextContent('shared incident'))
    fireEvent.click(screen.getByRole('button', { name: /shared incident/ }))

    // 2. Ask sequential follow-ups in Terminal A and Terminal B on the same thread; both branches survive.
    fireEvent.change(inputs[0], { target: { value: 'follow-up from A' } })
    fireEvent.click(submitButtons[0])
    act(() => { callbacks.onToken('# Reply A preserved.'); callbacks.onDone() })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })

    fireEvent.change(inputs[1], { target: { value: 'follow-up from B' } })
    fireEvent.click(submitButtons[1])
    act(() => { callbacks.onToken('# Reply B preserved.'); callbacks.onDone() })

    fireEvent.click(historyButtons[0])
    await waitFor(() => {
      const dialog = screen.getByRole('dialog', { name: 'Conversations' })
      expect(dialog.querySelectorAll('button[aria-label="Delete conversation"]').length).toBe(2)
    })

    // 3. Delete all threads from Terminal A -> reopening History in Terminal B clears stale entries.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete conversation' })
    for (const btn of deleteButtons) fireEvent.click(btn)
    fireEvent.click(historyButtons[0])
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    fireEvent.click(historyButtons[1])
    await waitFor(() => {
      const dialogB = within(screen.getByTestId('shared-b')).getByRole('dialog', { name: 'Conversations' })
      expect(dialogB).toHaveTextContent('No saved conversations yet')
    })
  })

  it('retains full >30-turn transcript when switching threads and returning in the same session', async () => {
    const memoryKey = 'v1:root@10.0.0.100'
    render(<AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" />)
    await act(async () => { await Promise.resolve() })

    for (let i = 1; i <= 16; i += 1) {
      ask(`prompt number ${i}`)
      act(() => { callbacks.onToken(`# reply number ${i}`); callbacks.onDone() })
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    fireEvent.click(screen.getByTestId('ai-new-thread'))
    expect(screen.queryByText('prompt number 1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('ai-thread-history'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Conversations' })).toHaveTextContent('prompt number 1'))
    fireEvent.click(screen.getByRole('button', { name: /prompt number 1/ }))

    expect(screen.getByText('prompt number 1')).toBeInTheDocument()
    expect(screen.getByText('reply number 16')).toBeInTheDocument()
  })

  it('moves a panel to a fresh thread after a rejected stale clear and never restores stuck running commands from local cache', async () => {
    const memoryKey = 'v1:root@10.0.0.101'
    render(
      <div>
        <div data-testid="clear-a"><AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" /></div>
        <div data-testid="clear-b"><AICommandBar {...base} memoryKey={memoryKey} memoryVaultId="v1" /></div>
      </div>,
    )
    await act(async () => { await Promise.resolve() })

    const panelA = screen.getByTestId('clear-a')
    const panelB = screen.getByTestId('clear-b')

    // Panel A starts thread, Panel B opens it from History.
    fireEvent.change(within(panelA).getByRole('textbox', { name: 'Describe what you want to do…' }), { target: { value: 'original incident' } })
    fireEvent.click(within(panelA).getByRole('button', { name: 'Generate command' }))
    act(() => { callbacks.onToken('# First finding.'); callbacks.onDone() })

    fireEvent.click(within(panelB).getByTestId('ai-thread-history'))
    await waitFor(() => expect(within(panelB).getByRole('dialog', { name: 'Conversations' })).toHaveTextContent('original incident'))
    fireEvent.click(within(panelB).getByRole('button', { name: /original incident/ }))

    // Panel A adds a newer reply, then Panel B clears chat (rejected clear) and asks a new prompt.
    fireEvent.change(within(panelA).getByRole('textbox', { name: 'Describe what you want to do…' }), { target: { value: 'newer reply from A' } })
    fireEvent.click(within(panelA).getByRole('button', { name: 'Generate command' }))
    act(() => { callbacks.onToken('# Must survive.'); callbacks.onDone() })
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    fireEvent.click(within(panelB).getByRole('button', { name: 'More actions' }))
    fireEvent.click(within(panelB).getByRole('menuitem', { name: 'Clear conversation' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    fireEvent.change(within(panelB).getByRole('textbox', { name: 'Describe what you want to do…' }), { target: { value: 'disk usage check' } })
    fireEvent.click(within(panelB).getByRole('button', { name: 'Generate command' }))
    act(() => { callbacks.onToken('# Disk is healthy.'); callbacks.onDone() })

    fireEvent.click(within(panelA).getByTestId('ai-thread-history'))
    await waitFor(() => {
      const dialog = within(panelA).getByRole('dialog', { name: 'Conversations' })
      expect(dialog).toHaveTextContent('original incident')
      expect(dialog).toHaveTextContent('disk usage check')
    })

    // Switching away during an in-flight command and returning must not leave a stuck running entry.
    cleanup()
    const bridge = fakeBridge('still running')
    render(<AICommandBar {...base} bridge={bridge} memoryKey="v1:root@10.0.0.102" memoryVaultId="v1" />)
    await act(async () => { await Promise.resolve() })
    ask('check uptime')
    act(() => { callbacks.onToken('uptime'); callbacks.onDone() })
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(screen.getByTestId('ai-run')).toHaveAttribute('data-state', 'running')

    fireEvent.click(screen.getByTestId('ai-new-thread'))
    fireEvent.click(screen.getByTestId('ai-thread-history'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Conversations' })).toHaveTextContent('check uptime'))
    fireEvent.click(screen.getByRole('button', { name: /check uptime/ }))
    expect(screen.queryByTestId('ai-run')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
  })

  it('collapses 2+ consecutive completed automatic check steps into an expandable step timeline', async () => {
    localStorage.setItem('shellbeam.aiRunMode.k-steps', 'read-only')
    const exec = vi.fn(async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0, durationMs: 20 }))
    const bridge = { ...fakeBridge('ok'), exec }
    render(<AICommandBar {...base} bridge={bridge} memoryKey="k-steps" />)

    ask('diagnose server')
    act(() => { callbacks.onToken('df -h'); callbacks.onDone() })
    await waitFor(() => expect(exec).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(streamAICommand).toHaveBeenCalledTimes(2))

    act(() => { callbacks.onToken('free -m'); callbacks.onDone() })
    await waitFor(() => expect(exec).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(streamAICommand).toHaveBeenCalledTimes(3))

    act(() => { callbacks.onToken('# All healthy.'); callbacks.onDone() })
    expect(screen.getByTestId('ai-step-group')).toHaveTextContent('Ran 2 read-only check steps')
    expect(screen.getByTestId('ai-note')).toHaveTextContent('All healthy.')
    fireEvent.click(screen.getByRole('button', { name: /Ran 2 read-only check steps/ }))
    expect(screen.getByText('df -h')).toBeInTheDocument()
    expect(screen.getByText('free -m')).toBeInTheDocument()
  })
})
