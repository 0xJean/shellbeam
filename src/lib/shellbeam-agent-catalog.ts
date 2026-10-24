import type { HostProfile } from './hosts'
import { downloadShellbeamAgentBytes } from './shellbeam-agent-download'
import { loadShellbeamAgentReleaseSettings, shellbeamAgentReleasePolicyFromSettings, type ShellbeamAgentReleaseSettings } from './shellbeam-agent-release-settings'
import { decideShellbeamAgentRelease, selectShellbeamAgentRelease, verifyShellbeamAgentReleaseSignature, type ValidatedShellbeamAgentRelease } from './shellbeam-agent-release'
import { runWorkspaceRemoteCommand } from './workspace-remote'

export function parseShellbeamAgentPlatform(output: string) {
  const [os, arch] = output.trim().split(/\r?\n/).map((value) => value.trim())
  const platform = os === 'Linux' ? 'linux' : os === 'Darwin' ? 'macos' : null
  const architecture = ['x86_64', 'amd64'].includes(arch) ? 'x86_64' : ['aarch64', 'arm64'].includes(arch) ? 'aarch64' : null
  if (!platform || !architecture) throw new Error('agent_platform_unsupported')
  return { platform, architecture }
}

export function validateShellbeamAgentCatalogUrl(value: string, hosts: string[]) {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hosts.some((host) => {
    const normalized = host.trim().toLowerCase().replace(/\.$/, '')
    return normalized.startsWith('*.') ? hostname === normalized.slice(2) || hostname.endsWith(`.${normalized.slice(2)}`) : hostname === normalized
  })) throw new Error('release_catalog_url_not_allowed')
  return url.toString()
}

/** User-initiated catalog loading. Selection is target-specific and both the
 * release envelope and the artifact metadata must validate before install. */
export async function loadShellbeamAgentCatalogRelease(options: {
  host: HostProfile
  vaultId: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  currentVersion?: string | null
  settings?: ShellbeamAgentReleaseSettings
  download?: typeof downloadShellbeamAgentBytes
  detect?: () => Promise<string>
}): Promise<ValidatedShellbeamAgentRelease> {
  const settings = options.settings ?? loadShellbeamAgentReleaseSettings()
  if (!settings.enabled || !settings.releaseManifestUrl) throw new Error('release_catalog_not_configured')
  const url = validateShellbeamAgentCatalogUrl(settings.releaseManifestUrl, settings.artifactAllowedHosts)
  const policy = { ...shellbeamAgentReleasePolicyFromSettings(settings), allowedChannels: [settings.channel] }
  const targetOutput = options.detect ? await options.detect() : await runWorkspaceRemoteCommand({ host: options.host, vaultId: options.vaultId, resolveAuthSecret: options.resolveAuthSecret, command: 'uname -s; uname -m' }).then((result) => {
    if (result.exitCode !== 0) throw new Error('agent_platform_check_failed')
    return result.stdout
  })
  const target = parseShellbeamAgentPlatform(targetOutput)
  const bytes = await (options.download ?? downloadShellbeamAgentBytes)(url, settings.artifactAllowedHosts, 512 * 1024)
  const catalog = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion?: unknown; manifests?: unknown[] }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.manifests) || catalog.manifests.length > 64) throw new Error('release_catalog_invalid')
  const manifests = catalog.manifests.filter((raw) => {
    const artifact = (raw as { artifact?: { platform?: string; architecture?: string } } | null)?.artifact
    return artifact?.platform === target.platform && artifact?.architecture === target.architecture
  })
  const selection = selectShellbeamAgentRelease({ manifests, policy, hostId: options.host.id, currentVersion: options.currentVersion })
  for (const candidate of selection.candidates) {
    try {
      await verifyShellbeamAgentReleaseSignature(candidate, settings.trustedReleasePublicKeyBase64)
      const localPolicy = decideShellbeamAgentRelease({ release: { ...candidate, manifest: { ...candidate.manifest, rollout: { percentage: settings.rolloutPercentage, salt: settings.rolloutSalt } } }, hostId: options.host.id, currentVersion: options.currentVersion })
      if (localPolicy.eligible) return candidate
    } catch { /* An unverified catalog entry is never installed. Try the next verified eligible version. */ }
  }
  throw new Error('release_catalog_no_eligible_signed_release')
}
