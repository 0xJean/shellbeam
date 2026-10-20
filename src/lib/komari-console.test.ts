import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { cancelMobileKomariConsole, komariConsoleBrowserId, komariConsoleMode, komariConsoleUrl, openMobileKomariConsole, prepareMobileKomariConsole } from './komari-console'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }))
afterEach(() => { vi.mocked(isTauri).mockReturnValue(false); vi.mocked(invoke).mockReset() })

describe('Komari console URL', () => {
  it.each([
    ['https://komari.example', 'https://komari.example/'],
    ['https://komari.example/reverse/proxy', 'https://komari.example/reverse/proxy/'],
    ['https://komari.example/reverse/proxy/', 'https://komari.example/reverse/proxy/'],
    ['https://komari.example/team%20ops?token=never-pass#api-key', 'https://komari.example/team%20ops/'],
    ['http://192.168.1.20:25774/monitoring', 'http://192.168.1.20:25774/monitoring/'],
    ['http://[::1]:25774', 'http://[::1]:25774/'],
  ])('keeps the HTTP(S) base path without credentials or URL state: %s', (endpoint, expected) => {
    expect(komariConsoleUrl(endpoint)).toBe(expected)
    expect(new URL('assets/app.js', komariConsoleUrl(endpoint)).pathname).toBe(`${new URL(expected).pathname}assets/app.js`)
  })

  it.each(['', 'komari.example', 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/console', 'ftp://komari.example', 'https://user:password@komari.example', 'https://token@komari.example', 'https://user%40name:secret@komari.example'])('rejects unsafe or malformed console addresses: %s', (endpoint) => {
    expect(() => komariConsoleUrl(endpoint)).toThrow()
  })
})

describe('Komari console native handoff', () => {
  it('keeps browser previews on the existing desktop adapter without native IPC', async () => {
    await expect(komariConsoleMode()).resolves.toBe('desktop')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'mobile'] as const)('uses the native %s capability instead of user-agent detection', async (mode) => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce(mode)
    await expect(komariConsoleMode()).resolves.toBe(mode)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('komari_console_mode')
  })

  it('fails on an unknown native capability instead of pretending a browser opened', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValueOnce('unexpected')
    await expect(komariConsoleMode()).rejects.toThrow('KOMARI_CONSOLE_UNAVAILABLE')
  })

  it('prepares only the saved integration scope and propagates native Vault rejection', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('VAULT_LOCKED')
    await expect(prepareMobileKomariConsole('vault-a', 'integration-a')).rejects.toBe('VAULT_LOCKED')
    expect(invoke).toHaveBeenCalledExactlyOnceWith('prepare_mobile_komari_console', { vaultId: 'vault-a', integrationId: 'integration-a' })
  })

  it('only opens or cancels a native-generated opaque request id', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(invoke).mockResolvedValueOnce(requestId)
    await expect(prepareMobileKomariConsole('vault-a', 'saved-id')).resolves.toBe(requestId)
    await openMobileKomariConsole(requestId)
    await cancelMobileKomariConsole(requestId)
    expect(invoke).toHaveBeenNthCalledWith(2, 'open_mobile_komari_console', { requestId })
    expect(invoke).toHaveBeenNthCalledWith(3, 'cancel_mobile_komari_console', { requestId })
    vi.mocked(invoke).mockResolvedValueOnce('https://unsafe.example?token=private')
    await expect(prepareMobileKomariConsole('vault-a', 'saved-id')).rejects.toThrow('KOMARI_CONSOLE_UNAVAILABLE')
  })
})


describe('scoped Komari main-window identity', () => {
  it('is stable for a pair, separates Vaults and integrations, and only uses safe label characters', () => {
    expect(komariConsoleBrowserId('vault-a', 'same')).toBe(komariConsoleBrowserId('vault-a', 'same'))
    expect(komariConsoleBrowserId('vault-a', 'same')).not.toBe(komariConsoleBrowserId('vault-b', 'same'))
    expect(komariConsoleBrowserId('ab', 'c')).not.toBe(komariConsoleBrowserId('a', 'bc'))
    expect(komariConsoleBrowserId('测试 / Vault', 'id:1')).toMatch(/^[a-z0-9-]+$/)
  })
})
