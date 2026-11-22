import { describe, expect, it } from 'vitest'
import {
  buildNetworkDiagnosticsCommand,
  formatDiagnosticsReportMarkdown,
  parseNetworkDiagnostics,
} from './network-diagnostics'

describe('network-diagnostics', () => {
  it('builds a bounded script and sanitizes custom targets', () => {
    const cmd = buildNetworkDiagnosticsCommand('9.9.9.9')
    expect(cmd).toContain('__SB_DIAG_SCHEMA=1')
    expect(cmd).toContain("'9.9.9.9'")
    expect(cmd).toContain('api.openai.com')

    const unsafe = buildNetworkDiagnosticsCommand('1.1.1.1; rm -rf /')
    expect(unsafe).not.toContain('rm -rf')
  })

  it('parses structured exit IP, ping latency/loss, and service reachability', () => {
    const sample = [
      '__SB_DIAG_SCHEMA=1',
      '__SB_DIAG_IP_BEGIN',
      '{"ip":"203.0.113.42","city":"Tokyo","country":"JP","org":"AS25820 IT7 Networks"}',
      'IPV6=2001:db8::42',
      '__SB_DIAG_IP_END',
      '__SB_DIAG_PROBES_BEGIN',
      'PROBE|cloudflare|Cloudflare|1.1.1.1|0|1.2|1.8|2.4',
      'PROBE|ct|China Telecom|202.96.128.86|33.3|42.1|48.5|55.0',
      'PROBE|cu|China Unicom|221.6.4.66|100|||',
      '__SB_DIAG_PROBES_END',
      '__SB_DIAG_SVC_BEGIN',
      'SVC|openai|OpenAI API|401|0.215',
      'SVC|netflix|Netflix|403|0.180',
      'SVC|youtube|YouTube|204|0.095',
      '__SB_DIAG_SVC_END',
    ].join('\n')

    const report = parseNetworkDiagnostics(sample, { now: 1_700_000_000_000, transport: 'direct' })
    expect(report.status).toBe('ready')
    expect(report.exitIp).toEqual({
      ipv4: '203.0.113.42',
      ipv6: '2001:db8::42',
      country: 'JP',
      city: 'Tokyo',
      org: 'AS25820 IT7 Networks',
    })
    expect(report.probes).toEqual([
      { id: 'cloudflare', label: 'Cloudflare', target: '1.1.1.1', minMs: 1.2, avgMs: 1.8, maxMs: 2.4, lossPercent: 0, status: 'ok' },
      { id: 'ct', label: 'China Telecom', target: '202.96.128.86', minMs: 42.1, avgMs: 48.5, maxMs: 55, lossPercent: 33.3, status: 'degraded' },
      { id: 'cu', label: 'China Unicom', target: '221.6.4.66', minMs: null, avgMs: null, maxMs: null, lossPercent: 100, status: 'failed' },
    ])
    expect(report.services).toEqual([
      { id: 'openai', label: 'OpenAI API', httpCode: 401, latencyMs: 215, reachable: true },
      { id: 'netflix', label: 'Netflix', httpCode: 403, latencyMs: 180, reachable: false },
      { id: 'youtube', label: 'YouTube', httpCode: 204, latencyMs: 95, reachable: true },
    ])

    const md = formatDiagnosticsReportMarkdown('Tokyo Edge', report)
    expect(md).toContain('203.0.113.42')
    expect(md).toContain('OpenAI API: Reachable')
    expect(md).toContain('Netflix: Blocked/Unreachable')
  })

  it('fails closed when output lacks schema header', () => {
    expect(parseNetworkDiagnostics('random error').status).toBe('failed')
  })
})
