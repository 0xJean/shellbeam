import { useState } from 'react'
import { Check, Copy, Globe2, Loader2, Play, Radio, ShieldCheck, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CountryFlag } from '@/components/country-flag'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import {
  formatDiagnosticsReportMarkdown,
  runHostNetworkDiagnostics,
  type NetworkDiagnosticsReport,
} from '@/lib/network-diagnostics'
import { cn } from '@/lib/utils'

const COPY = {
  en: {
    title: 'Network & IP Diagnostics',
    subtitle: 'On-demand SSH check · Exit IP, carrier latency & AI/service reachability',
    run: 'Run Check',
    running: 'Checking...',
    rerun: 'Re-run',
    copyReport: 'Copy report',
    copied: 'Copied',
    customTarget: 'Custom ping target (optional, e.g. 9.9.9.9)',
    exitIp: 'Exit IP & ASN',
    latency: 'Latency & Packet Loss',
    services: 'Service & AI Reachability',
    loss: 'loss',
    timeout: 'timeout',
    reachable: 'Reachable',
    blocked: 'Blocked',
    failed: 'Could not collect network diagnostics over SSH.',
  },
  'zh-CN': {
    title: '网络与 IP 一键体检',
    subtitle: '按需通过 SSH 检测 · 出口 IP / ASN、多线路延迟丢包与 AI/服务连通性',
    run: '开始体检',
    running: '检测中...',
    rerun: '重新检测',
    copyReport: '复制报告',
    copied: '已复制',
    customTarget: '自定义 Ping 目标（可选，如 9.9.9.9）',
    exitIp: '出口 IP 与 ASN',
    latency: '多节点延迟与丢包',
    services: 'AI 与流媒体连通性',
    loss: '丢包',
    timeout: '超时',
    reachable: '可达',
    blocked: '受限/不可达',
    failed: '无法通过 SSH 完成网络体检，请检查主机连通性或 curl / ping 工具。',
  },
} as const

export function HostNetworkDiagnosticsCard({
  host,
  resolveAuthSecret,
}: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const { locale } = useT()
  const c = COPY[locale]
  const [customTarget, setCustomTarget] = useState('')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<NetworkDiagnosticsReport | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleRun() {
    setRunning(true)
    setCopied(false)
    try {
      const next = await runHostNetworkDiagnostics({
        host,
        vaultId: host.vaultId,
        resolveAuthSecret,
        customTarget: customTarget.trim() || undefined,
      })
      setReport(next)
    } finally {
      setRunning(false)
    }
  }

  async function handleCopy() {
    if (!report) return
    try {
      await navigator.clipboard.writeText(formatDiagnosticsReportMarkdown(host.name, report))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  }

  return (
    <section
      data-testid="host-network-diagnostics"
      className="space-y-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--workspace-text-strong)]">
            <Radio className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" aria-hidden="true" />
            {c.title}
          </h4>
          <p className="mt-0.5 text-[11px] text-[var(--workspace-text-muted)]">{c.subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {report && report.status !== 'failed' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="host-network-diag-copy"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? c.copied : c.copyReport}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="host-network-diag-run"
            disabled={running}
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => void handleRun()}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? c.running : report ? c.rerun : c.run}
          </Button>
        </div>
      </div>

      <Input
        value={customTarget}
        onChange={(event) => setCustomTarget(event.target.value)}
        placeholder={c.customTarget}
        aria-label={c.customTarget}
        className="h-8 bg-[var(--workspace-surface-input)] font-mono text-xs"
      />

      {report && report.status === 'failed' && (
        <p role="alert" className="rounded-md bg-[var(--workspace-status-bad-bg)] px-2.5 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">
          {c.failed}
        </p>
      )}

      {report && report.status !== 'failed' && (
        <div className="space-y-3">
          {(report.exitIp.ipv4 || report.exitIp.ipv6) && (
            <div className="space-y-1.5">
              <div className="text-[10.5px] font-medium text-[var(--workspace-text-subtle)]">{c.exitIp}</div>
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 text-xs">
                {report.exitIp.country ? (
                  <CountryFlag countryCode={report.exitIp.country} className="h-3.5 w-5" />
                ) : (
                  <Globe2 className="h-3.5 w-3.5 text-[var(--workspace-text-muted)]" aria-hidden="true" />
                )}
                {report.exitIp.ipv4 && (
                  <span className="font-mono font-medium text-[var(--workspace-text-strong)]">{report.exitIp.ipv4}</span>
                )}
                {report.exitIp.ipv6 && (
                  <span className="rounded bg-[var(--workspace-surface-700)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--workspace-text-muted)]">
                    IPv6: {report.exitIp.ipv6}
                  </span>
                )}
                {(report.exitIp.city || report.exitIp.country || report.exitIp.org) && (
                  <span className="text-[11px] text-[var(--workspace-text-muted)]">
                    {[report.exitIp.country, report.exitIp.city, report.exitIp.org].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </div>
          )}

          {report.probes.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10.5px] font-medium text-[var(--workspace-text-subtle)]">{c.latency}</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {report.probes.map((probe) => (
                  <div
                    key={probe.id}
                    data-testid={`diag-probe-${probe.id}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--workspace-text-strong)]">{probe.label}</div>
                      <div className="truncate font-mono text-[10px] text-[var(--workspace-text-subtle)]">{probe.target}</div>
                    </div>
                    <div className="shrink-0 text-right font-mono tabular-nums">
                      <div
                        className={cn(
                          'text-xs font-semibold',
                          probe.status === 'ok'
                            ? 'text-[color:var(--workspace-status-good-text)]'
                            : probe.status === 'degraded'
                              ? 'text-[color:var(--workspace-status-warn-text)]'
                              : 'text-[color:var(--workspace-status-bad-text)]',
                        )}
                      >
                        {probe.avgMs != null ? `${probe.avgMs} ms` : c.timeout}
                      </div>
                      <div className="text-[10px] text-[var(--workspace-text-muted)]">
                        {c.loss} {probe.lossPercent ?? 100}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.services.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10.5px] font-medium text-[var(--workspace-text-subtle)]">{c.services}</div>
              <div className="flex flex-wrap gap-1.5">
                {report.services.map((svc) => (
                  <span
                    key={svc.id}
                    data-testid={`diag-svc-${svc.id}`}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium',
                      svc.reachable
                        ? 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]'
                        : 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
                    )}
                    title={`HTTP ${svc.httpCode ?? 'ERR'}`}
                  >
                    {svc.reachable ? <ShieldCheck className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}
                    <span>{svc.label}</span>
                    <span className="font-mono text-[10px] opacity-80 tabular-nums">
                      {svc.reachable ? (svc.latencyMs != null ? `${svc.latencyMs}ms` : c.reachable) : c.blocked}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
