import pins from '../../releases/compatible-probe-pins.json'

export interface ProbeArtifactIdentity {
  version: string
  sha256: string
  runtime?: string
  platform?: string
  architecture?: string
  sizeBytes?: number
}

/** Provenance describes exact reviewed bytes, not the selected publisher or a
 * version supplied by a server. Native signature and ownership checks remain
 * authoritative; unknown/custom bytes keep a neutral label. */
export function probeReleaseIdentity(artifact: ProbeArtifactIdentity | null | undefined) {
  if (!artifact || artifact.runtime !== 'komari' || artifact.platform !== 'linux'
    || !['amd64', 'arm64'].includes(artifact.architecture ?? '')) return null
  const versions: Record<string, { amd64: { sha256: string; size: number }; arm64: { sha256: string; size: number }; source?: { repository: string; commit: string; upstreamVersion: string } }> = pins.versions
  const entry = versions[artifact.version]
  const pin = entry?.[artifact.architecture as 'amd64' | 'arm64']
  if (!pin || pin.sha256 !== artifact.sha256 || pin.size !== artifact.sizeBytes) return null
  if (entry.source?.repository === '0xJean/shellbeam-monitoring-agent'
    && /^[a-f0-9]{40}$/.test(entry.source.commit)) {
    return { product: 'shellbeam' as const, repository: entry.source.repository, commit: entry.source.commit, upstreamVersion: entry.source.upstreamVersion }
  }
  if (!entry.source && ['1.5.10', '1.5.11'].includes(artifact.version)) {
    return { product: 'upstream' as const, repository: 'komari-monitor/komari-agent', commit: null, upstreamVersion: artifact.version }
  }
  return null
}

export function probeReleaseDisplay(artifact: ProbeArtifactIdentity | null | undefined, version: string | null | undefined, labels: { shellbeam: string; upstream: string; compatible: string }) {
  if (!version) return '—'
  const identity = artifact?.version === version ? probeReleaseIdentity(artifact) : null
  return `${labels[identity?.product ?? 'compatible']} ${version}`
}
