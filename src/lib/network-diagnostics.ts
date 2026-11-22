import type { HostProfile } from './hosts'
import { operationTransport } from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'

export interface ExitIpInfo {
  ipv4: string | null
  ipv6: string | null
  country: string | null
  city: string | null
  org: string | null
}

export interface LatencyProbeResult {
  id: string
  label: string
  target: string
  avgMs: number | null
  minMs: number | null
  maxMs: number | null
  lossPercent: number | null
  status: 'ok' | 'degraded' | 'failed'
}

export interface ServiceReachabilityResult {
  id: string
  label: string
  httpCode: number | null
  latencyMs: number | null
  reachable: boolean
}

export interface NetworkDiagnosticsReport {
  status: 'ready' | 'partial' | 'failed'
  exitIp: ExitIpInfo
  probes: LatencyProbeResult[]
  services: ServiceReachabilityResult[]
  sampledAt: number
  transport: 'direct' | 'proxy-jump'
  errorCode?: string
}

export const DEFAULT_LATENCY_TARGETS: ReadonlyArray<{ id: string; label: string; target: string }> = [
  { id: 'cloudflare', label: 'Cloudflare', target: '1.1.1.1' },
  { id: 'google', label: 'Google DNS', target: '8.8.8.8' },
  { id: 'ct', label: 'China Telecom', target: '202.96.128.86' },
  { id: 'cu', label: 'China Unicom', target: '221.6.4.66' },
  { id: 'cm', label: 'China Mobile', target: '221.179.155.161' },
]

export const DEFAULT_SERVICE_CHECKS: ReadonlyArray<{ id: string; label: string; url: string }> = [
  { id: 'openai', label: 'OpenAI API', url: 'https://api.openai.com/v1/models' },
  { id: 'anthropic', label: 'Claude API', url: 'https://api.anthropic.com/v1/messages' },
  { id: 'github', label: 'GitHub', url: 'https://api.github.com' },
  { id: 'netflix', label: 'Netflix', url: 'https://www.netflix.com/title/81280792' },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/generate_204' },
]

function sanitizeTarget(target: string): string | null {
  const cleaned = target.trim()
  if (!cleaned || cleaned.length > 128) return null
  if (!/^[A-Za-z0-9.:-]+$/.test(cleaned)) return null
  return cleaned
}

export function buildNetworkDiagnosticsCommand(customTarget?: string): string {
  const probes = [...DEFAULT_LATENCY_TARGETS]
  const extra = customTarget ? sanitizeTarget(customTarget) : null
  if (extra && !probes.some((item) => item.target === extra)) {
    probes.push({ id: 'custom', label: extra, target: extra })
  }

  const probeScript = probes.map((p) => (
    `OUT=$(LC_ALL=C ping -c 3 -W 2 -q '${p.target}' 2>/dev/null || true); `
    + `LOSS=$(printf '%s\\n' "$OUT" | awk -F',' '/packet loss/{for(i=1;i<=NF;i++)if($i ~ /packet loss/){gsub(/[^0-9.]/,"",$i);print $i;exit}}'); `
    + `RTT=$(printf '%s\\n' "$OUT" | awk -F'=' '/min\\/avg\\/max/{gsub(/^ +/,"",$2);split($2,a,"/");print a[1]"|"a[2]"|"a[3];exit}'); `
    + `printf 'PROBE|%s|%s|%s|%s|%s\\n' '${p.id}' '${p.label}' '${p.target}' "\${LOSS:-100}" "\${RTT:-||}"`
  )).join('\n')

  const serviceScript = DEFAULT_SERVICE_CHECKS.map((s) => (
    `RES=$(curl -sS -o /dev/null -w '%{http_code}|%{time_total}' --max-time 3 -L '${s.url}' 2>/dev/null || printf '000|0'); `
    + `printf 'SVC|%s|%s|%s\\n' '${s.id}' '${s.label}' "$RES"`
  )).join('\n')

  return [
    "printf '%s\\n' '__SB_DIAG_SCHEMA=1'",
    "printf '%s\\n' '__SB_DIAG_IP_BEGIN'",
    "if command -v curl >/dev/null 2>&1; then",
    "  curl -4 -sS --max-time 3 https://ipinfo.io/json 2>/dev/null | tr '\\n' ' '; printf '\\n'",
    "  printf 'IPV6=%s\\n' \"$(curl -6 -sS --max-time 2 https://ifconfig.co/ip 2>/dev/null | tr -d '\\r\\n' || true)\"",
    'fi',
    "printf '%s\\n' '__SB_DIAG_IP_END'",
    "printf '%s\\n' '__SB_DIAG_PROBES_BEGIN'",
    'if command -v ping >/dev/null 2>&1; then',
    probeScript,
    'fi',
    "printf '%s\\n' '__SB_DIAG_PROBES_END'",
    "printf '%s\\n' '__SB_DIAG_SVC_BEGIN'",
    'if command -v curl >/dev/null 2>&1; then',
    serviceScript,
    'fi',
    "printf '%s\\n' '__SB_DIAG_SVC_END'",
  ].join('\n')
}

function extractSection(output: string, name: 'IP' | 'PROBES' | 'SVC'): string[] {
  const begin = `__SB_DIAG_${name}_BEGIN\n`
  const end = `__SB_DIAG_${name}_END`
  const start = output.indexOf(begin)
  const finish = start < 0 ? -1 : output.indexOf(end, start + begin.length)
  if (start < 0 || finish < 0) return []
  return output.slice(start + begin.length, finish).split('\n').map((l) => l.trim()).filter(Boolean)
}

function parseFinite(raw?: string): number | null {
  if (!raw) return null
  const num = Number(raw)
  return Number.isFinite(num) ? Math.round(num * 10) / 10 : null
}

function parseIpSection(lines: string[]): ExitIpInfo {
  const info: ExitIpInfo = { ipv4: null, ipv6: null, country: null, city: null, org: null }
  for (const line of lines) {
    if (line.startsWith('IPV6=')) {
      const val = line.slice(5).trim()
      if (val && val.includes(':')) info.ipv6 = val
      continue
    }
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.ip === 'string' && parsed.ip.trim()) info.ipv4 = parsed.ip.trim()
        if (typeof parsed.country === 'string' && parsed.country.trim()) info.country = parsed.country.trim()
        if (typeof parsed.city === 'string' && parsed.city.trim()) info.city = parsed.city.trim()
        if (typeof parsed.org === 'string' && parsed.org.trim()) info.org = parsed.org.trim()
      } catch {
        // Ignore malformed JSON responses from third-party IP endpoints.
      }
    }
  }
  return info
}

export function parseNetworkDiagnostics(
  output: string,
  options: { now?: number; transport?: NetworkDiagnosticsReport['transport'] } = {},
): NetworkDiagnosticsReport {
  const now = options.now ?? Date.now()
  const transport = options.transport ?? 'direct'
  if (!output.startsWith('__SB_DIAG_SCHEMA=1\n')) {
    return {
      status: 'failed',
      exitIp: { ipv4: null, ipv6: null, country: null, city: null, org: null },
      probes: [],
      services: [],
      sampledAt: now,
      transport,
      errorCode: 'invalid_diagnostics_output',
    }
  }

  const exitIp = parseIpSection(extractSection(output, 'IP'))

  const probes: LatencyProbeResult[] = []
  for (const line of extractSection(output, 'PROBES')) {
    if (!line.startsWith('PROBE|')) continue
    const [, id, label, target, lossRaw, minRaw, avgRaw, maxRaw] = line.split('|')
    if (!id || !target) continue
    const lossPercent = parseFinite(lossRaw)
    const minMs = parseFinite(minRaw)
    const avgMs = parseFinite(avgRaw)
    const maxMs = parseFinite(maxRaw)
    const status: LatencyProbeResult['status'] = avgMs === null || (lossPercent !== null && lossPercent >= 50)
      ? 'failed'
      : avgMs > 150 || (lossPercent !== null && lossPercent > 0)
        ? 'degraded'
        : 'ok'
    probes.push({ id, label: label || target, target, minMs, avgMs, maxMs, lossPercent, status })
  }

  const services: ServiceReachabilityResult[] = []
  for (const line of extractSection(output, 'SVC')) {
    if (!line.startsWith('SVC|')) continue
    const [, id, label, codeRaw, secRaw] = line.split('|')
    if (!id) continue
    const code = Number(codeRaw)
    const httpCode = Number.isInteger(code) && code > 0 ? code : null
    const sec = Number(secRaw)
    const latencyMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null
    // Note: API endpoints often return 401/403/405 when unauthenticated — that still proves network reachability.
    const reachable = httpCode !== null && httpCode >= 200 && httpCode < 500 && !(id === 'netflix' && (httpCode === 403 || httpCode === 404))
    services.push({ id, label: label || id, httpCode, latencyMs, reachable })
  }

  const hasData = Boolean(exitIp.ipv4 || exitIp.ipv6 || probes.length > 0 || services.length > 0)
  const status: NetworkDiagnosticsReport['status'] = !hasData
    ? 'failed'
    : exitIp.ipv4 && probes.length > 0 && services.length > 0
      ? 'ready'
      : 'partial'

  return { status, exitIp, probes, services, sampledAt: now, transport }
}

export async function runHostNetworkDiagnostics(options: {
  host: HostProfile
  vaultId?: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  customTarget?: string
  now?: number
}): Promise<NetworkDiagnosticsReport> {
  const transport = operationTransport(options.host)
  const now = options.now ?? Date.now()
  try {
    const result = await runWorkspaceRemoteCommand({
      host: options.host,
      vaultId: options.vaultId,
      resolveAuthSecret: options.resolveAuthSecret,
      command: buildNetworkDiagnosticsCommand(options.customTarget),
      audit: { action: 'network.diagnostics', target: options.customTarget || 'exit-ip-latency-services' },
    })
    if (result.exitCode !== 0 && !result.stdout.startsWith('__SB_DIAG_SCHEMA=1\n')) {
      return {
        status: 'failed',
        exitIp: { ipv4: null, ipv6: null, country: null, city: null, org: null },
        probes: [],
        services: [],
        sampledAt: now,
        transport,
        errorCode: result.errorCode ?? 'diagnostics_failed',
      }
    }
    return parseNetworkDiagnostics(result.stdout, { now, transport })
  } catch {
    return {
      status: 'failed',
      exitIp: { ipv4: null, ipv6: null, country: null, city: null, org: null },
      probes: [],
      services: [],
      sampledAt: now,
      transport,
      errorCode: 'diagnostics_unavailable',
    }
  }
}

export function formatDiagnosticsReportMarkdown(hostName: string, report: NetworkDiagnosticsReport): string {
  const lines = [`### Network & IP Diagnostics — ${hostName}`]
  if (report.exitIp.ipv4 || report.exitIp.ipv6) {
    lines.push(
      `- Exit IPv4: ${report.exitIp.ipv4 ?? 'N/A'} | IPv6: ${report.exitIp.ipv6 ?? 'N/A'}`,
      `- Location / ASN: ${[report.exitIp.country, report.exitIp.city, report.exitIp.org].filter(Boolean).join(' · ') || 'Unknown'}`,
    )
  }
  if (report.probes.length > 0) {
    lines.push('', '**Latency & Packet Loss**')
    for (const p of report.probes) {
      lines.push(`- ${p.label} (${p.target}): ${p.avgMs != null ? `${p.avgMs} ms` : 'timeout'} · loss ${p.lossPercent ?? 100}%`)
    }
  }
  if (report.services.length > 0) {
    lines.push('', '**Service Reachability**')
    for (const s of report.services) {
      lines.push(`- ${s.label}: ${s.reachable ? 'Reachable' : 'Blocked/Unreachable'} (HTTP ${s.httpCode ?? 'ERR'}${s.latencyMs != null ? `, ${s.latencyMs} ms` : ''})`)
    }
  }
  return lines.join('\n')
}
