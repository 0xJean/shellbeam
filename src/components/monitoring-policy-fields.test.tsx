import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { policyCopy, type LoadRule } from '@/lib/monitoring-policy'
import { MonitoringChannelFields } from './monitoring-channel-fields'
import { MonitoringLoadPolicyFields } from './monitoring-load-policy-fields'
const c = policyCopy.en
const node = { id: 'node', name: 'WEB', createdAt: 'original' }
const rule: LoadRule = { id: 'rule', name: 'CPU', nodeId: node.id, nodeCreatedAt: node.createdAt, metric: 'cpu', threshold: 80, recovery: 60, durationSeconds: 60, recoverySeconds: 30, enabled: true }
beforeEach(() => localStorage.setItem('shellbeam.locale', 'en'))
afterEach(() => { cleanup(); localStorage.clear() })
it('keeps channel secrets hidden and unknown fields untouched while changing declared fields', () => {
  const onChange = vi.fn(); const values = { __shellbeam_channel_schema: { type: 'managed', data: [{ key: 'token', type: 'string', name: 'Token' }, { key: 'script', type: 'richtext', name: 'Script' }, { key: 'raw', type: 'html', name: 'Opaque' }] }, token: 'synthetic-token', script: '<script>untrusted</script>', raw: '<img onerror=alert(1)>', future: { keep: true } }
  render(<I18nProvider><MonitoringChannelFields values={values} disabled={false} nodes={[]} tasks={[]} onChange={onChange} /></I18nProvider>)
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password'); expect(screen.getByLabelText('Token')).toHaveAttribute('readonly')
  expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show Script' }))
  fireEvent.change(screen.getByLabelText('Script'), { target: { value: 'new-script' } })
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...values, script: 'new-script' })
})
it('preserves unknown selector choices and uses typed node identifiers', () => {
  const onChange = vi.fn(); const values = { __shellbeam_channel_schema: { type: 'managed', data: [{ key: 'targets', type: 'nodes', name: 'Targets' }] }, targets: ['missing'], future: 'keep' }
  render(<I18nProvider><MonitoringChannelFields values={values} disabled={false} nodes={[node]} tasks={[]} onChange={onChange} /></I18nProvider>)
  expect(screen.getByRole('checkbox', { name: 'missing' })).toBeChecked()
  fireEvent.click(screen.getByRole('checkbox', { name: 'WEB' }))
  expect(onChange).toHaveBeenCalledWith({ ...values, targets: ['missing', 'node'] })
})
it('creates rules tied to server node creation identity and preserves extension revision', () => {
  const onChange = vi.fn(); const values = { extension_identity: 'server', revision: 3, rules: [], silences: [] }
  render(<I18nProvider><MonitoringLoadPolicyFields values={values} disabled={false} nodes={[node]} onChange={onChange} /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: c.addRule }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...values, rules: [expect.objectContaining({ nodeId: 'node', nodeCreatedAt: 'original', enabled: true })] })
})
it('removing the last scoped rule disables its silence instead of broadening active scope', () => {
  const onChange = vi.fn(); const silence = { id: 'silence', name: 'Night', enabled: true, ruleIds: ['rule'], kind: 'weekly', days: [1], startMinute: 1320, endMinute: 420, timezone: 'UTC' }
  const values = { extension_identity: 'server', revision: 3, rules: [rule], silences: [silence] }
  render(<I18nProvider><MonitoringLoadPolicyFields values={values} disabled={false} nodes={[node]} onChange={onChange} /></I18nProvider>)
  fireEvent.click(screen.getAllByRole('button', { name: c.remove })[0])
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...values, rules: [], silences: [{ ...silence, enabled: false, ruleIds: [] }] })
})
it.each(['en', 'zh-CN'] as const)('shows delivery uncertainty separately from alert fact and preserves read-only review (%s)', async locale => {
  localStorage.setItem('shellbeam.locale', locale)
  const onChange = vi.fn(); const copy = policyCopy[locale]
  render(<I18nProvider><MonitoringLoadPolicyFields values={{ rules: [rule], silences: [] }} disabled nodes={[node]} onChange={onChange} status={{ rule: { status: 'firing' } }} events={[{ ruleId: 'rule', name: 'CPU', kind: 'firing', sampledAt: 1, delivery: 'unknown' }]} /></I18nProvider>)
  expect(screen.getByLabelText(copy.threshold)).toBeDisabled()
  fireEvent.click(screen.getByText(/Recent server load events|最近的服务端负载事件/, { selector: 'summary' }))
  expect(screen.getByText(new RegExp(copy.deliveryUnknown))).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: copy.remove }))
  await act(async () => {}); await waitFor(() => expect(onChange).not.toHaveBeenCalled())
})
