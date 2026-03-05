export interface InvokeStandardError {
  code: string
  source: string
  retryable: boolean
  message: string
  detail?: string
  raw: string
}

function extractPayload(raw: string): Record<string, unknown> | null {
  const normalized = raw.replace(/^Error:\s*/, '').trim()
  const candidates = [normalized]
  const jsonMatch = normalized.match(/\{[\s\S]*\}$/)
  if (jsonMatch) candidates.push(jsonMatch[0].trim())
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // Continue trying fallback candidates.
    }
  }
  return null
}

export function normalizeInvokeError(error: unknown): InvokeStandardError {
  const raw = String(error)
  const payload = extractPayload(raw)
  if (payload) {
    return {
      code: typeof payload.code === 'string' ? payload.code : 'unknown_error',
      source: typeof payload.source === 'string' ? payload.source : 'unknown',
      retryable: typeof payload.retryable === 'boolean' ? payload.retryable : false,
      message: typeof payload.message === 'string' ? payload.message : 'Operation failed',
      detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      raw,
    }
  }
  return {
    code: 'unknown_error',
    source: 'unknown',
    retryable: false,
    message: 'Operation failed',
    detail: raw,
    raw,
  }
}

export function toInvokeErrorMessage(error: unknown) {
  const normalized = normalizeInvokeError(error)
  return normalized.detail ? `${normalized.message}: ${normalized.detail}` : normalized.message
}
