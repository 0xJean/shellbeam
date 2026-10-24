import type { HostProfile } from './hosts'
import { getProbeProviderRegistry } from './probe-scheduler'
import type { ProbeSnapshot } from './probe-provider'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import type { LocalAlertObservation, LocalAlertRule } from './local-alert-rules'
import type { CommandRunResult } from './sessions'
import { operationTransport } from './operation-job'

function quote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'` }
export function buildLocalServiceCheckCommand(targets: string[]) {
  const safe = [...new Set(targets)]
  if (safe.some((target) => !/^[A-Za-z0-9@_.:-]+$/.test(target))) throw new Error('local_alert_invalid_target')
  return `bash -lc ${quote(safe.map((target, i) => `state=$(systemctl show --property=ActiveState --value -- ${quote(target)} 2>/dev/null) || state=unknown; printf '__SB_RULE_SERVICE_${i}=%s\\n' "$state"`).join('; '))}`
}
export async function collectLocalAlertObservations(options: {
  vaultId?: string
  host: HostProfile
  rules: LocalAlertRule[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  now?: number
  probe?: () => Promise<ProbeSnapshot>
  runCommand?: (options: { vaultId?: string; host: HostProfile; resolveAuthSecret: (host: HostProfile) => Promise<string>; command: string }) => Promise<CommandRunResult>
}): Promise<LocalAlertObservation[]> {
  const now = options.now ?? Date.now()
  const transport = operationTransport(options.host)
  const result: LocalAlertObservation[] = []
  const resources = options.rules.filter((r) => r.enabled && ['cpu', 'memory', 'disk'].includes(r.metric))
  if (resources.length) {
    let snapshot: ProbeSnapshot | undefined
    try { snapshot = options.probe ? await options.probe() : (await getProbeProviderRegistry().probe({ vaultId: options.vaultId, host: options.host, sections: ['metrics'], resolveAuthSecret: options.resolveAuthSecret })).snapshot } catch { /* absence remains unknown */ }
    const metrics = snapshot?.metrics
    for (const rule of resources) {
      const fresh = snapshot?.health === 'online' && metrics && metrics.freshness.expiresAt >= now && now - metrics.freshness.sampledAt <= rule.freshnessMs
      const key = rule.metric === 'cpu' ? 'cpuPercent' : rule.metric === 'memory' ? 'memoryPercent' : 'diskPercent'
      result.push({ ruleId: rule.id, value: fresh ? metrics.data[key] : null, sampledAt: fresh ? metrics.freshness.sampledAt : now, source: snapshot?.provider.kind ?? 'ssh-agentless', transport: snapshot?.transport ?? transport })
    }
  }
  const services = options.rules.filter((r) => r.enabled && r.metric === 'service')
  if (services.length) {
    const targets = [...new Set(services.map((r) => r.target!))]
    let output = ''
    try { const response = await (options.runCommand ?? runWorkspaceRemoteCommand)({ vaultId: options.vaultId, host: options.host, resolveAuthSecret: options.resolveAuthSecret, command: buildLocalServiceCheckCommand(targets) }); if (response.exitCode === 0) output = response.stdout } catch { /* unknown is distinct from service failure */ }
    for (const rule of services) {
      const active = output.match(new RegExp(`(?:^|\\n)__SB_RULE_SERVICE_${targets.indexOf(rule.target!)}=([^\\r\\n]*)`))?.[1]
      result.push({ ruleId: rule.id, value: active === 'active' ? 0 : active === 'inactive' || active === 'failed' ? 1 : null, sampledAt: now, source: 'ssh-agentless', transport })
    }
  }
  return result
}
