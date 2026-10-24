import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

it('isolates fixed diagnostics by Vault and host and emits only on a state change', async () => {
  const state = await import('./probe-alert-runtime-state')
  const changed = vi.fn()
  window.addEventListener(state.PROBE_ALERT_RUNTIME_CHANGED, changed)
  try {
    state.setProbeAlertRuntimeDiagnostic('vault', 'host', 'publication-unavailable')
    state.setProbeAlertRuntimeDiagnostic('vault', 'host', 'publication-unavailable')
    expect(changed).toHaveBeenCalledOnce()
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host')).toBe('publication-unavailable')
    expect(state.getProbeAlertRuntimeDiagnostic('other', 'host')).toBeNull()
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'other')).toBeNull()
    expect(state.getProbeAlertRuntimeDiagnostic(null, 'host')).toBeNull()
    state.setProbeAlertRuntimeDiagnostic('other', 'host', 'listener-failed')
    state.clearProbeAlertRuntimeDiagnostic('vault', 'host')
    state.clearProbeAlertRuntimeDiagnostic('vault', 'host')
    expect(changed).toHaveBeenCalledTimes(3)
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull()
    expect(state.getProbeAlertRuntimeDiagnostic('other', 'host')).toBe('listener-failed')
  } finally { window.removeEventListener(state.PROBE_ALERT_RUNTIME_CHANGED, changed) }
})

it('does not retain raw errors or invalid identities and bounds the scoped registry', async () => {
  const state = await import('./probe-alert-runtime-state')
  const changed = vi.fn()
  window.addEventListener(state.PROBE_ALERT_RUNTIME_CHANGED, changed)
  try {
    for (const vault of ['', 'vault\nprivate', 'v'.repeat(161)]) state.setProbeAlertRuntimeDiagnostic(vault, 'host', 'publication-unavailable')
    state.setProbeAlertRuntimeDiagnostic('vault', 'host\u007f', 'publication-unavailable')
    state.setProbeAlertRuntimeDiagnostic('vault', 'host', 'private provider error' as Parameters<typeof state.setProbeAlertRuntimeDiagnostic>[2])
    expect(changed).not.toHaveBeenCalled()
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host')).toBeNull()
    for (let index = 0; index <= 256; index++) state.setProbeAlertRuntimeDiagnostic('vault', 'host-' + index, 'persistence-unavailable')
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host-0')).toBeNull()
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host-1')).toBe('persistence-unavailable')
    expect(state.getProbeAlertRuntimeDiagnostic('vault', 'host-256')).toBe('persistence-unavailable')
  } finally { window.removeEventListener(state.PROBE_ALERT_RUNTIME_CHANGED, changed) }
})
