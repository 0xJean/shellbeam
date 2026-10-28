import { getHostIdentity } from '@/lib/host-identity'
import { rememberCertificateScan } from '@/lib/certificate-cache'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import {
  runCertificateOperation,
  runSiteOperation,
  runSiteSslScan,
  type CertificateRecord,
  type SiteRecord,
  type SiteSslScanResult,
} from '@/lib/sites-ssl'
import { fill } from '@/lib/locales/probe-install'
import { workspaceOpsPanelsCopy } from '@/lib/locales/workspace-ops-panels'
import { cn } from '@/lib/utils'
import { CircleAlert, FileCheck, FlaskConical, RefreshCw, RotateCw, ScanSearch } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface SitesSslPanelProps {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

type Tone = 'good' | 'warn' | 'bad' | 'idle'

const DOT: Record<Tone, string> = {
  good: 'bg-[var(--workspace-status-good)]',
  warn: 'bg-[var(--workspace-status-warn)]',
  bad: 'bg-[var(--workspace-status-bad)]',
  idle: 'bg-[var(--workspace-text-subtle)]',
}

const CHIP: Record<Tone, string> = {
  good: 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
  warn: 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
  bad: 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
  idle: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]',
}

function certificateTone(certificate: CertificateRecord): Tone {
  if (certificate.status === 'valid') return 'good'
  if (certificate.status === 'expiring') return 'warn'
  if (certificate.status === 'expired') return 'bad'
  return 'idle'
}

function issuerLabel(issuer: string) {
  const fields = Object.fromEntries(issuer.split(/,\s*|\//).map((part) => part.split('=').map((value) => value.trim())).filter((pair) => pair.length === 2 && pair[1]))
  return [fields.O, fields.CN].filter(Boolean).join(' ') || issuer
}

const secondaryButton = 'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 text-xs font-medium text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:pointer-events-none disabled:opacity-50'
const primaryButton = 'inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[color:var(--workspace-primary-500)] px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50'

function operationSummary(job: { jobId: string; auditId: string; status: string }, output: string) {
  const header = `job=${job.jobId} audit=${job.auditId} status=${job.status}`
  return output ? `${header}\n\n${output}` : header
}

export function SitesSslPanel({ host, resolveAuthSecret }: SitesSslPanelProps) {
  const { t, locale } = useT()
  const c = workspaceOpsPanelsCopy[locale].ssl
  const [result, setResult] = useState<SiteSslScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const scope = JSON.stringify([host.vaultId, getHostIdentity(host)])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const scanGeneration = useRef(0)

  const scan = useCallback(async () => {
    const generation = ++scanGeneration.current
    const isCurrent = () => generation === scanGeneration.current && scope === currentScope.current
    setLoading(true)
    setError('')
    try {
      const snapshot = await runSiteSslScan({ host, resolveAuthSecret })
      if (isCurrent()) { setResult(snapshot); rememberCertificateScan(host.vaultId, snapshot) }
    } catch (cause) {
      if (!isCurrent()) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [host, resolveAuthSecret, scope])

  useEffect(() => {
    const generations = scanGeneration
    setResult(null); setOutput(''); setAction(null)
    void scan()
    return () => { generations.current++ }
  }, [scan])

  async function siteAction(site: SiteRecord, operation: 'config-test' | 'reload') {
    const actionScope = scope
    setAction(`${operation}:${site.id}`)
    setError('')
    try {
      const execution = await runSiteOperation({
        host,
        resolveAuthSecret,
        site,
        operation,
        confirmMessage: t(`workspace.sitesSsl.confirm.${operation}`),
      })
      if (actionScope !== currentScope.current) return
      if (!execution) {
        setOutput(t('workspace.sitesSsl.cancelled'))
        return
      }
      setOutput(operationSummary(execution.job, [`verification=${execution.value.verification.status}; ${execution.value.verification.summary}`, execution.value.stdout, execution.value.stderr].filter(Boolean).join('\n')))
      if (execution.value.snapshot) { setResult(execution.value.snapshot); rememberCertificateScan(host.vaultId, execution.value.snapshot) }
    } catch (cause) {
      if (actionScope === currentScope.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (actionScope === currentScope.current) setAction(null)
    }
  }

  async function certificateAction(operation: 'renew-dry-run' | 'renew') {
    const actionScope = scope
    setAction(operation)
    setError('')
    try {
      const execution = await runCertificateOperation({
        host,
        resolveAuthSecret,
        operation,
        confirmMessage: t(`workspace.sitesSsl.confirm.${operation}`),
      })
      if (actionScope !== currentScope.current) return
      if (!execution) {
        setOutput(t('workspace.sitesSsl.cancelled'))
        return
      }
      setOutput(operationSummary(execution.job, [`verification=${execution.value.verification.status}; ${execution.value.verification.summary}`, execution.value.stdout, execution.value.stderr].filter(Boolean).join('\n')))
      if (execution.value.snapshot) { setResult(execution.value.snapshot); rememberCertificateScan(host.vaultId, execution.value.snapshot) }
    } catch (cause) {
      if (actionScope === currentScope.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (actionScope === currentScope.current) setAction(null)
    }
  }

  const formatDate = (value: number) => new Date(value).toLocaleDateString(locale)

  return (
    <section data-testid="sites-ssl-panel" className="flex min-h-0 flex-col gap-4 p-4 text-[var(--workspace-text)] md:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('workspace.sitesSsl.title')}</h2>
          <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{c.summary}</p>
        </div>
        <div className="flex items-center gap-3">
          {result && <span className="text-xs text-[var(--workspace-text-subtle)]">{fill(c.lastScan, { time: new Date(result.checkedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</span>}
          <button type="button" className={cn(primaryButton, 'h-8 px-3')} onClick={() => void scan()} disabled={loading || action !== null}>
            {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.scan')}
          </button>
        </div>
      </header>

      {result?.errorSummary && <p role="alert" className="rounded-lg bg-[var(--workspace-status-warn-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-warn-text)]">{result.errorSummary}</p>}
      {error && <p role="alert" className="rounded-lg bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{error}</p>}
      {!result && !loading && !error && <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><CircleAlert className="h-3.5 w-3.5" />{t('workspace.sitesSsl.notRun')}</div>}

      <div className="grid min-h-0 gap-3 xl:grid-cols-2">
        <div className="sb-card flex min-w-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
            <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.sitesSsl.sites')}</h3>
            <span className="text-xs text-[var(--workspace-text-subtle)]">{result?.sites.length ?? 0}</span>
          </div>
          {result?.sites.length ? <div className="divide-y divide-[color:var(--workspace-border-soft)]">{result.sites.map((site) => (
            <div key={site.id} className="flex items-start gap-3 px-4 py-3 text-xs">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT[site.status === 'active' ? 'good' : site.status === 'configured' ? 'warn' : 'idle'])} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{site.name}</div>
                <div className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{site.domains.join(', ')}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px]', CHIP.idle)}>{site.server}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px]', CHIP[site.ssl ? 'good' : 'idle'])}>{site.ssl ? t('workspace.sitesSsl.https') : t('workspace.sitesSsl.http')}</span>
                </div>
                <div className="mt-1.5 truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{c.root} {site.root || t('workspace.sitesSsl.noRoot')}</div>
                {site.configPath && <div className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{c.config} {site.configPath}</div>}
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                <button type="button" className={secondaryButton} disabled={action !== null} onClick={() => void siteAction(site, 'config-test')}><FileCheck className="h-3.5 w-3.5" />{action === `config-test:${site.id}` ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.configTest')}</button>
                <button type="button" className={secondaryButton} disabled={action !== null} onClick={() => void siteAction(site, 'reload')}><RotateCw className="h-3.5 w-3.5" />{action === `reload:${site.id}` ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.reload')}</button>
              </div>
            </div>
          ))}</div> : <p className="px-4 py-6 text-xs text-[var(--workspace-text-muted)]">{loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.noSites')}</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="sb-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.sitesSsl.certificates')}</h3>
                <span className="text-xs text-[var(--workspace-text-subtle)]">{result?.certificates.length ?? 0}</span>
              </div>
              <div className="flex gap-2">
                <button type="button" className={secondaryButton} disabled={action !== null} onClick={() => void certificateAction('renew-dry-run')}><FlaskConical className="h-3.5 w-3.5" />{action === 'renew-dry-run' ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.renewDryRun')}</button>
                <button type="button" className={primaryButton} disabled={action !== null} onClick={() => void certificateAction('renew')}><RefreshCw className="h-3.5 w-3.5" />{action === 'renew' ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.renew')}</button>
              </div>
            </div>
            {result?.certificates.length ? <div className="divide-y divide-[color:var(--workspace-border-soft)]">{result.certificates.map((certificate) => {
              const tone = certificateTone(certificate)
              const days = certificate.daysRemaining
              return (
                <div key={certificate.id} className="flex items-center gap-3 px-4 py-3 text-xs">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[tone])} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{certificate.domains.join(' · ') || certificate.subject || certificate.path}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" title={certificate.issuer || undefined}>{[certificate.issuer && issuerLabel(certificate.issuer), certificate.path].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', CHIP[tone])}>{t(`workspace.sitesSsl.status.${certificate.status}`)}</span>
                  <span data-testid="certificate-countdown" className={cn('w-24 shrink-0 text-right font-mono text-xs', tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : tone === 'warn' ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-strong)]')} title={certificate.notAfter == null ? undefined : fill(c.expiresOn, { date: formatDate(certificate.notAfter) })}>
                    {days == null ? t('workspace.sitesSsl.daysUnknown') : days < 0 ? fill(c.daysAgo, { count: -days }) : fill(c.daysLeft, { count: days })}
                  </span>
                </div>
              )
            })}</div> : <p className="px-4 py-6 text-xs text-[var(--workspace-text-muted)]">{loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.noCertificates')}</p>}
          </div>

          {output && (
            <div className="sb-card flex min-h-0 flex-col overflow-hidden">
              <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5"><h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{c.output}</h3></div>
              <pre data-testid="sites-ssl-output" className="max-h-72 overflow-auto whitespace-pre-wrap bg-[var(--workspace-surface-950)] px-4 py-3 font-mono text-[11px] leading-5 text-[var(--workspace-text)]">{output}</pre>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default SitesSslPanel
