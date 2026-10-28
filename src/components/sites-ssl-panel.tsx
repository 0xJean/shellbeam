import { getHostIdentity } from '@/lib/host-identity'
import { rememberCertificateScan } from '@/lib/certificate-cache'
import { Button } from '@/components/ui/button'
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
import { BadgeCheck, CircleAlert, ExternalLink, RefreshCw, RotateCw, ShieldCheck, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface SitesSslPanelProps {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function siteStatusTone(site: SiteRecord) {
  if (site.status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

function certificateStatusTone(certificate: CertificateRecord) {
  if (certificate.status === 'valid') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (certificate.status === 'expiring') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (certificate.status === 'expired') return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
  return 'border-muted-foreground/30 bg-muted text-muted-foreground'
}

function operationSummary(job: { jobId: string; auditId: string; status: string }, output: string) {
  const header = `job=${job.jobId} audit=${job.auditId} status=${job.status}`
  return output ? `${header}\n\n${output}` : header
}

export function SitesSslPanel({ host, resolveAuthSecret }: SitesSslPanelProps) {
  const { t } = useT()
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

  return (
    <section data-testid="sites-ssl-panel" className="space-y-4 rounded-xl border border-border/60 bg-card px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" />{t('workspace.sitesSsl.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('workspace.sitesSsl.description')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void scan()} disabled={loading || action !== null}>
          <RefreshCw className={loading ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
          {loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.scan')}
        </Button>
      </div>

      {result?.errorSummary && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{result.errorSummary}</p>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('workspace.sitesSsl.sites')}</h3><span className="text-[11px] text-muted-foreground">{result?.sites.length ?? 0}</span></div>
          {result?.sites.length ? result.sites.map((site) => (
            <div key={site.id} className="rounded-lg border border-border/50 px-3 py-3 text-xs">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate font-medium">{site.name}</div><div className="mt-1 truncate text-[11px] text-muted-foreground">{site.domains.join(' · ')}</div></div><span className={`rounded-full border px-2 py-1 text-[10px] ${siteStatusTone(site)}`}>{site.server} · {site.ssl ? t('workspace.sitesSsl.https') : t('workspace.sitesSsl.http')}</span></div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground"><span>{site.root || t('workspace.sitesSsl.noRoot')}</span>{site.configPath && <span>{site.configPath}</span>}</div>
              <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={action !== null} onClick={() => void siteAction(site, 'config-test')}><Wrench className="mr-1 h-3 w-3" />{action === `config-test:${site.id}` ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.configTest')}</Button><Button type="button" size="sm" variant="outline" disabled={action !== null} onClick={() => void siteAction(site, 'reload')}><RotateCw className="mr-1 h-3 w-3" />{action === `reload:${site.id}` ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.reload')}</Button></div>
            </div>
          )) : <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">{loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.noSites')}</p>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('workspace.sitesSsl.certificates')}</h3><span className="text-[11px] text-muted-foreground">{result?.certificates.length ?? 0}</span></div>
          {result?.certificates.length ? result.certificates.map((certificate) => (
            <div key={certificate.id} className="rounded-lg border border-border/50 px-3 py-3 text-xs">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate font-medium">{certificate.domains.join(' · ') || certificate.subject || certificate.path}</div><div className="mt-1 truncate text-[11px] text-muted-foreground">{certificate.issuer || certificate.path}</div></div><span className={`rounded-full border px-2 py-1 text-[10px] ${certificateStatusTone(certificate)}`}>{t(`workspace.sitesSsl.status.${certificate.status}`)}</span></div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground"><span>{certificate.daysRemaining == null ? t('workspace.sitesSsl.daysUnknown') : t('workspace.sitesSsl.daysRemaining', { count: certificate.daysRemaining })}</span><span className="truncate">{certificate.path}</span></div>
            </div>
          )) : <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">{loading ? t('workspace.sitesSsl.scanning') : t('workspace.sitesSsl.noCertificates')}</p>}
          <div className="flex flex-wrap gap-2 pt-1"><Button type="button" size="sm" variant="outline" disabled={action !== null} onClick={() => void certificateAction('renew-dry-run')}><BadgeCheck className="mr-1 h-3 w-3" />{action === 'renew-dry-run' ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.renewDryRun')}</Button><Button type="button" size="sm" variant="outline" disabled={action !== null} onClick={() => void certificateAction('renew')}><ExternalLink className="mr-1 h-3 w-3" />{action === 'renew' ? t('workspace.sitesSsl.running') : t('workspace.sitesSsl.renew')}</Button></div>
        </div>
      </div>

      {output && <pre data-testid="sites-ssl-output" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/30 p-3 text-[11px] leading-5">{output}</pre>}
      {!result && !loading && !error && <div className="flex items-center gap-2 text-xs text-muted-foreground"><CircleAlert className="h-3.5 w-3.5" />{t('workspace.sitesSsl.notRun')}</div>}
    </section>
  )
}

export default SitesSslPanel
