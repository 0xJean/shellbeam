import type { KomariProbeBaseline } from './komari-alerts'
import type { ProbeSnapshot } from './probe-provider'

type KomariReportSnapshot = Pick<ProbeSnapshot, 'provider' | 'host' | 'health' | 'metrics' | 'inventory' | 'errors'>

/** A missing first report must not hide an independent outage or provider
 * failure. Retry exhaustion is merely a diagnostic of the same empty read. */
export function hasOnlyKomariMissingReport(snapshot: KomariReportSnapshot | null | undefined): boolean {
  return Boolean(snapshot && snapshot.provider.kind === 'komari' && snapshot.health === 'unknown'
    && !snapshot.metrics && !snapshot.inventory
    && snapshot.errors.some((error) => error.section === 'metrics' && error.code === 'empty')
    && snapshot.errors.every((error) => error.section === 'metrics' && error.code === 'empty'
      || error.section === 'provider' && error.code === 'recovery-retry-exhausted'))
}

/** Waiting is a data-source state, never evidence that an SSH host is down. */
export function isKomariWaitingForFirstReport(snapshot: KomariReportSnapshot | null | undefined, baselines: readonly KomariProbeBaseline[] = []): boolean {
  return Boolean(snapshot && hasOnlyKomariMissingReport(snapshot)
    && !baselines.some((row) => row.integrationId === snapshot.provider.id
      && row.nodeId === snapshot.provider.nodeId && row.hostId === snapshot.host.hostId
      && (row.endpoint ?? '') === (snapshot.provider.endpoint ?? '')))
}
