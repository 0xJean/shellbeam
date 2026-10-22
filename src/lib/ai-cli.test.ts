import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { streamCliCommand, cliErrorMessage } from './ai-cli'
import { DEFAULT_AI_SETTINGS, isAIConfigured, loadAISettings, saveAISettings, streamAICommand } from './ai'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), Channel: class { onmessage = () => {} } }))
const callbacks = () => ({ onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() })
type Start = { request: { requestId: string; prompt: string; context: string }; channel: { onmessage: (event: unknown) => void } }
const tick = async () => { await Promise.resolve(); await Promise.resolve() }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(isTauri).mockReturnValue(true); localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en') })

describe('built-in assistant CLI transport', () => {
  it('migrates old settings without losing API profiles and routes CLI without API credentials', async () => {
    const api = { ...DEFAULT_AI_SETTINGS, apiKey: 'preserved-key', providerProfiles: { anthropic: { apiKey: 'other-key', model: 'old-model' } } }
    saveAISettings(api); expect(loadAISettings()).toEqual(api)
    const cli = { ...loadAISettings(), backend: 'codex-cli' as const }
    saveAISettings(cli); expect(isAIConfigured(cli)).toBe(true)
    const cb = callbacks()
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { channel, request } = args as unknown as Start
      expect(JSON.stringify(request)).not.toMatch(/preserved-key|other-key|apiKey/)
      channel.onmessage({ type: 'token', text: 'pwd' }); channel.onmessage({ type: 'done' })
    })
    await streamAICommand(cli, 'show directory', 'remote output', cb)
    expect(cb.onToken).toHaveBeenCalledWith('pwd'); expect(cb.onDone).toHaveBeenCalledOnce()
    expect(loadAISettings().apiKey).toBe('preserved-key')
  })
  it('cancels even when aborted before native registration is acknowledged and ignores late output', async () => {
    let acknowledge!: () => void; let start!: Start
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'ai_cli_start') { start = args as unknown as Start; return new Promise<void>((done) => { acknowledge = done }) as ReturnType<typeof invoke> }
      return Promise.resolve(undefined)
    })
    const ctrl = new AbortController(); const cb = callbacks()
    const promise = streamCliCommand('claude-code', undefined, 'prompt', 'context', cb, ctrl.signal)
    ctrl.abort(); expect(invoke).toHaveBeenCalledTimes(1)
    acknowledge(); await promise
    expect(invoke).toHaveBeenLastCalledWith('ai_cli_cancel', { requestId: start.request.requestId })
    start.channel.onmessage({ type: 'token', text: 'late' }); start.channel.onmessage({ type: 'done' })
    expect(cb.onToken).not.toHaveBeenCalled(); expect(cb.onDone).not.toHaveBeenCalled()
  })
  it('isolates concurrent channels and settles errors once without leaking native diagnostics', async () => {
    const calls: Start[] = []
    vi.mocked(invoke).mockImplementation(async (_command, args) => { calls.push(args as unknown as Start) })
    const a = callbacks(), b = callbacks()
    const pa = streamCliCommand('claude-code', undefined, 'first', '', a)
    const pb = streamCliCommand('codex-cli', undefined, 'second', '', b)
    await tick()
    expect(calls[0].request.requestId).not.toBe(calls[1].request.requestId)
    calls[1].channel.onmessage({ type: 'token', text: 'pwd' }); calls[1].channel.onmessage({ type: 'done' })
    calls[0].channel.onmessage({ type: 'error', code: 'secret-token=private' }); calls[0].channel.onmessage({ type: 'done' })
    await Promise.all([pa, pb])
    expect(a.onError).toHaveBeenCalledWith(cliErrorMessage('failed')); expect(a.onDone).not.toHaveBeenCalled()
    expect(b.onToken).toHaveBeenCalledWith('pwd'); expect(b.onDone).toHaveBeenCalledOnce()
    expect(JSON.stringify(a.onError.mock.calls)).not.toContain('secret-token')
  })
  it('fails clearly in browser preview without trying API fallback or IPC', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const cb = callbacks(); await streamCliCommand('codex-cli', undefined, 'prompt', '', cb)
    expect(cb.onError).toHaveBeenCalledWith(cliErrorMessage('desktop_only')); expect(invoke).not.toHaveBeenCalled()
  })
})
