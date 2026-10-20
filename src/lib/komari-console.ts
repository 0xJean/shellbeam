import { normalizeKomariEndpoint } from './komari'
import { invoke, isTauri } from '@tauri-apps/api/core'

export type KomariConsoleMode = 'desktop' | 'mobile'

/** Native platform capability, rather than a user-agent guess. Browser previews
 * keep the existing desktop browser adapter. Unknown native responses fail closed. */
export async function komariConsoleMode(): Promise<KomariConsoleMode> {
  if (!isTauri()) return 'desktop'
  const mode = await invoke<unknown>('komari_console_mode')
  if (mode !== 'desktop' && mode !== 'mobile') throw new Error('KOMARI_CONSOLE_UNAVAILABLE')
  return mode
}

/** The mobile native adapter resolves the saved endpoint itself, under its Vault
 * gate. Arbitrary URLs and API credentials never cross this opening interface. */
export async function prepareMobileKomariConsole(vaultId: string, integrationId: string): Promise<string> {
  const requestId = await invoke<unknown>('prepare_mobile_komari_console', { vaultId, integrationId })
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error('KOMARI_CONSOLE_UNAVAILABLE')
  return requestId
}

export async function openMobileKomariConsole(requestId: string): Promise<void> {
  await invoke('open_mobile_komari_console', { requestId })
}

export async function cancelMobileKomariConsole(requestId: string): Promise<void> {
  await invoke('cancel_mobile_komari_console', { requestId })
}

/** The saved endpoint is a server base URL, including any reverse-proxy path.
 * Never attach API credentials or reuse query/fragment state in the console. */
export function komariConsoleUrl(endpoint: string): string {
  const url = new URL(normalizeKomariEndpoint(endpoint))
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

/** Collision-free native label for a Vault/integration pair. Stable across
 * repeated opens; no credentials or endpoint are part of the identity. */
export function komariConsoleBrowserId(vaultId: string, integrationId: string): string {
  const encode = (value: string) => Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `komari-console-${encode(vaultId)}-${encode(integrationId)}`
}
