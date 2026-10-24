import { invoke, isTauri } from '@tauri-apps/api/core'

/** Native downloads avoid WebView CORS and validate every redirect against
 * the same explicit host policy. Public release metadata carries no auth. */
export async function downloadShellbeamAgentBytes(url: string, allowedHosts: string[], maxBytes: number): Promise<Uint8Array> {
  if (typeof isTauri === 'function' && isTauri()) {
    const result = await invoke<{ bytesB64: string }>('download_shellbeam_agent_release', { url, allowedHosts, maxBytes })
    const binary = atob(result.bytesB64)
    if (binary.length > maxBytes) throw new Error('artifact_size_exceeded')
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal, credentials: 'omit' })
    if (!response.ok) throw new Error(`artifact_download_http_${response.status}`)
    if (!response.body || Number(response.headers.get('content-length')) > maxBytes) throw new Error('artifact_size_exceeded')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.length
        if (total > maxBytes) { await reader.cancel(); throw new Error('artifact_size_exceeded') }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  } finally { clearTimeout(timer) }
}
