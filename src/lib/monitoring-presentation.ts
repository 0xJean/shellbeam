import type { Locale } from './i18n'
import type { KomariAlertRecord } from './komari-alerts'
import { monitoringDiagnosticsCopy, monitoringPresentationCopy } from './locales/monitoring-presentation'
import { fill } from './locales/probe-install'

/** Presentation only. Canonical provider IDs, diagnostics and alert titles are
 * persisted contracts used by TS/Rust incident grouping and notification dedupe.
 * Never write these labels back to a record or apply them to user names. */
export function monitoringProviderLabel(provider: string, locale: Locale): string {
  const copy = monitoringPresentationCopy[locale].providers
  if (provider === 'komari') return copy.komari
  if (provider === 'komari-local') return copy.komariLocal
  if (provider === 'ssh-agentless') return copy.sshAgentless
  return provider
}

/** Keep the opaque source/node suffix intact so two services remain distinct. */
export function monitoringHistorySourceLabel(key: string, locale: Locale): string {
  const separator = key.indexOf(':')
  if (separator < 0) return monitoringProviderLabel(key, locale)
  return `${monitoringProviderLabel(key.slice(0, separator), locale)} · ${key.slice(separator + 1)}`
}

function knownDiagnostic(message: string, locale: Locale): string | undefined {
  const { diagnostics, diagnosticPrefixes } = monitoringDiagnosticsCopy[locale]
  const known = Object.hasOwn(diagnostics, message) ? diagnostics[message] : undefined
  if (known) return known
  const separator = message.indexOf(': ')
  if (separator < 0) return undefined
  const key = message.slice(0, separator)
  const prefix = Object.hasOwn(diagnosticPrefixes, key) ? diagnosticPrefixes[key] : undefined
  return prefix ? `${prefix}: ${message.slice(separator + 2)}` : undefined
}

/** Only known application diagnostics are translated. An arbitrary upstream
 * response (even one containing Komari) remains verbatim. */
export function monitoringDiagnostic(message: string, locale: Locale): string {
  const known = knownDiagnostic(message, locale)
  if (known !== undefined) return known
  const retry = /^Probe recovery failed after (\d+) retr(?:y|ies): (.+)$/.exec(message)
  const detail = retry ? knownDiagnostic(retry[2], locale) : undefined
  if (retry && detail !== undefined) {
    return fill(monitoringPresentationCopy[locale].probeRetry, { count: retry[1], detail })
  }
  return message
}

export function monitoringAlertTitle(record: Pick<KomariAlertRecord, 'kind' | 'title'>, locale: Locale): string {
  if (!['probe-offline', 'probe-stale', 'probe-unknown', 'probe-error:metrics', 'probe-error:provider', 'probe-error:inventory'].includes(record.kind)) return record.title
  const section = /^Komari Probe (metrics|provider|inventory) error: (.+)$/.exec(record.title)
  if (section && record.kind === `probe-error:${section[1]}`) {
    const copy = monitoringPresentationCopy[locale]
    const label = copy.sections[section[1] as 'metrics' | 'provider' | 'inventory']
    const detail = monitoringDiagnostic(section[2], locale)
    return fill(copy.sectionError, { label, detail })
  }
  return monitoringDiagnostic(record.title, locale)
}

/** The legacy generated target is an identifier, not a user-supplied name. */
export function monitoringOperationTarget(target: string, action: string, locale: Locale): string {
  const node = action === 'agent.check' ? /^Komari node ([a-zA-Z0-9._:-]+)$/.exec(target) : null
  return node ? `${monitoringPresentationCopy[locale].monitoringNode} ${node[1]}` : target
}
