import { describe, expect, it, vi } from 'vitest'
import { groupKomariAlertIncidents } from './komari-alert-incidents'
import { reconcileKomariAlerts } from './komari-alerts'
import { komariAlertNotificationEvent } from './komari-alert-notifications'
import { dispatchNotification } from './notification-dispatch'
import { monitoringAlertTitle, monitoringDiagnostic, monitoringHistorySourceLabel, monitoringOperationTarget, monitoringProviderLabel } from './monitoring-presentation'
import en from './locales/en'
import zh from './locales/zh-CN'

const scope = { integrationId: 'service', nodeId: 'node', hostId: 'host', count: 1, updatedAt: 1000 }

describe('Monitoring presentation compatibility', () => {
  it('projects historical diagnostics in both languages without changing incident grouping or audit records', () => {
    const state = reconcileKomariAlerts([], [
      { ...scope, kind: 'probe-unknown', title: 'Komari Probe health is unknown' },
      { ...scope, kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations' },
      { ...scope, kind: 'probe-error:provider', title: 'Komari Probe provider error: Probe recovery failed after 2 retries: Komari returned no dated metric observations' },
    ], { now: 1000 })
    const original = JSON.stringify(state)
    const grouped = groupKomariAlertIncidents(state.alerts)
    expect(grouped).toHaveLength(1)
    for (const locale of ['en', 'zh-CN'] as const) {
      const labels = state.alerts.map(record => monitoringAlertTitle(record, locale))
      expect(labels.every(label => !label.includes('Komari'))).toBe(true)
      expect(labels.some(label => label.includes('2'))).toBe(true)
    }
    expect(groupKomariAlertIncidents(state.alerts)).toEqual(grouped)
    expect(JSON.stringify(state)).toBe(original)
  })

  it.each(['constructor', 'toString', '__proto__'])('preserves prototype-looking upstream text %s', message => {
    for (const locale of ['en', 'zh-CN'] as const) {
      expect(monitoringDiagnostic(message, locale)).toBe(message)
      const retry = `Probe recovery failed after 2 retries: ${message}`
      expect(monitoringDiagnostic(retry, locale)).toBe(retry)
    }
  })

  it('projects only exact native error prefixes while retaining arbitrary diagnostic details', () => {
    const suffix = 'Komari custom database: locked'
    expect(monitoringDiagnostic(`Save Komari integration failed: ${suffix}`, 'en')).toBe(`Save monitoring integration failed: ${suffix}`)
    expect(monitoringDiagnostic(`Save Komari integration failed: ${suffix}`, 'zh-CN')).toBe(`保存监控服务失败: ${suffix}`)
    expect(monitoringDiagnostic('Komari credential reference is invalid', 'zh-CN')).toBe('监控凭据引用无效')
    expect(monitoringDiagnostic('Komari integration belongs to another Vault', 'en')).toBe('Monitoring service belongs to another Vault')
    expect(monitoringDiagnostic('Komari snapshot is too large', 'en')).toBe('Monitoring snapshot is too large')
    expect(monitoringDiagnostic('Probe recovery failed after 2 retries: Komari snapshot is too large', 'en')).toBe('Probe recovery failed after 2 retries: Monitoring snapshot is too large')
    for (const original of ['Other: Save Komari integration failed: raw', 'Save Komari custom failed: raw', 'Probe recovery failed after 2 retries: Komari custom backend error']) {
      expect(monitoringDiagnostic(original, 'zh-CN')).toBe(original)
    }
  })

  it('preserves user rule names, arbitrary upstream messages and unrecognized kinds', () => {
    const custom = { kind: 'server-load', title: 'Komari Probe health is unknown' }
    expect(monitoringAlertTitle(custom, 'zh-CN')).toBe(custom.title)
    const external = 'Komari custom backend: credentials rejected'
    expect(monitoringDiagnostic(external, 'en')).toBe(external)
    expect(monitoringAlertTitle({ kind: 'probe-error:metrics', title: `Komari Probe metrics error: ${external}` }, 'en')).toBe(`Metric collection error: ${external}`)
    expect(monitoringAlertTitle({ kind: 'custom', title: 'Komari monitoring data recovered' }, 'en')).toBe('Komari monitoring data recovered')
  })

  it('does not replay a previously delivered canonical notification after display wording changes', async () => {
    const state = reconcileKomariAlerts([], [{ ...scope, kind: 'probe-error:metrics', severity: 'critical', title: 'Komari monitoring source is offline' }], { now: 1000 })
    const record = state.alerts[0]; const audit = state.audit[0]
    const projected = komariAlertNotificationEvent(record, audit)
    const original = { ...projected, title: record.title, message: `${record.title} opened` }
    const onLocal = vi.fn()
    const first = await dispatchNotification(original, { policy: { channels: ['local'], cooldownMs: 0 }, onLocal, now: 1000 })
    expect(first.deliveries).toEqual([{ channel: 'local', status: 'delivered', deliveredAt: 1000 }])
    const second = await dispatchNotification(projected, { policy: { channels: ['local'], cooldownMs: 0 }, state: first.state, onLocal, now: 2000 })
    expect(projected.title).toBe('Monitoring source is offline')
    expect(projected.eventId).toBe(audit.auditId)
    expect(projected.fingerprint).toBe(record.fingerprint)
    expect(projected.metadata).toMatchObject({ alertId: record.alertId, auditId: audit.auditId })
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(second.deliveries).toEqual([{ channel: 'local', status: 'skipped', reason: 'deduplicated' }])
  })

  it('labels known providers without changing opaque identities or user audit targets', () => {
    expect(monitoringProviderLabel('komari', 'en')).toBe('Monitoring service')
    expect(monitoringHistorySourceLabel('komari:komari-main:node-1', 'zh-CN')).toBe('监控服务 · komari-main:node-1')
    expect(monitoringProviderLabel('my-komari-service', 'en')).toBe('my-komari-service')
    expect(monitoringOperationTarget('Komari node node-1', 'agent.check', 'en')).toBe('Monitoring node node-1')
    expect(monitoringOperationTarget('Komari node node-1', 'command.execute', 'en')).toBe('Komari node node-1')
  })

  it('keeps locale keys and the recovery/local-handling distinction', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en['komariAlerts.description']).toMatch(/local/)
    expect(en['komariAlerts.description']).toMatch(/fresh evidence/)
    expect(zh['komariAlerts.description']).toContain('本地')
    expect(en['settings.komariDescription']).toContain('ShellBeam Server')
    expect(en['settings.komariDescription']).not.toContain('compatible monitoring service')
    expect(zh['settings.komariDescription']).toContain('ShellBeam Server')
    expect(zh['settings.komariDescription']).not.toContain('兼容的监控服务')
  })
})
