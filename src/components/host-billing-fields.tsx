import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import {
  BILLING_CURRENCIES,
  BILLING_CYCLES,
  normalizeHostBilling,
  type HostBilling,
} from '@/lib/host-billing'
import { useT } from '@/lib/i18n'

export interface HostBillingFormDraft {
  provider: string
  price: string
  currency: string
  cycle: string
  expiresAt: string
  monthlyTrafficGb: string
  autoRenew: boolean
}

// eslint-disable-next-line react-refresh/only-export-components -- Co-located draft helpers for HostBillingFields callers.
export function initialBillingFormDraft(billing?: HostBilling | null): HostBillingFormDraft {
  return {
    provider: billing?.provider ?? '',
    price: billing?.price != null ? String(billing.price) : '',
    currency: billing?.currency ?? 'USD',
    cycle: billing?.cycle ?? 'monthly',
    expiresAt: billing?.expiresAt ?? '',
    monthlyTrafficGb: billing?.monthlyTrafficGb != null ? String(billing.monthlyTrafficGb) : '',
    autoRenew: Boolean(billing?.autoRenew),
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- Co-located draft helpers for HostBillingFields callers.
export function billingFormDraftToHostBilling(draft: HostBillingFormDraft): HostBilling | undefined {
  const hasPrice = draft.price.trim().length > 0
  return normalizeHostBilling({
    provider: draft.provider,
    price: hasPrice ? Number(draft.price) : undefined,
    currency: hasPrice ? draft.currency : undefined,
    cycle: hasPrice ? draft.cycle : undefined,
    expiresAt: draft.expiresAt,
    monthlyTrafficGb: draft.monthlyTrafficGb.trim() ? Number(draft.monthlyTrafficGb) : undefined,
    autoRenew: draft.autoRenew,
  })
}

export function HostBillingFields({
  value,
  onChange,
  defaultExpanded = false,
  disabled = false,
}: {
  value: HostBillingFormDraft
  onChange: (next: HostBillingFormDraft) => void
  defaultExpanded?: boolean
  disabled?: boolean
}) {
  const { locale } = useT()
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className="rounded-lg border border-border/80 bg-muted/20 p-3">
      <button
        type="button"
        data-testid="host-billing-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between text-left text-[13px] font-medium text-foreground"
      >
        <span>{locale === 'zh-CN' ? '资产与续费记录（可选）' : 'Asset & Renewal Tracking (Optional)'}</span>
        <span className="text-xs text-muted-foreground">
          {expanded ? (locale === 'zh-CN' ? '收起' : 'Hide') : (locale === 'zh-CN' ? '展开' : 'Configure')}
        </span>
      </button>
      {expanded && (
        <div data-testid="host-billing-fields" className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '服务商' : 'Provider'}</label>
              <Input
                data-testid="host-billing-provider"
                disabled={disabled}
                value={value.provider}
                onChange={(e) => onChange({ ...value, provider: e.target.value })}
                placeholder={locale === 'zh-CN' ? '如 Aliyun / Vultr / 搬瓦工' : 'e.g. Hetzner, Vultr, AWS'}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '到期日期' : 'Expires On'}</label>
              <Input
                data-testid="host-billing-expires"
                disabled={disabled}
                type="date"
                value={value.expiresAt}
                onChange={(e) => onChange({ ...value, expiresAt: e.target.value })}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '价格' : 'Price'}</label>
              <Input
                data-testid="host-billing-price"
                disabled={disabled}
                type="number"
                min="0"
                step="0.01"
                value={value.price}
                onChange={(e) => onChange({ ...value, price: e.target.value })}
                placeholder="9.99"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '币种' : 'Currency'}</label>
              <NativeSelect
                data-testid="host-billing-currency"
                disabled={disabled}
                aria-label={locale === 'zh-CN' ? '币种' : 'Currency'}
                value={value.currency}
                onChange={(e) => onChange({ ...value, currency: e.target.value })}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {BILLING_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '计费周期' : 'Cycle'}</label>
              <NativeSelect
                data-testid="host-billing-cycle"
                disabled={disabled}
                aria-label={locale === 'zh-CN' ? '计费周期' : 'Cycle'}
                value={value.cycle}
                onChange={(e) => onChange({ ...value, cycle: e.target.value })}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {BILLING_CYCLES.map((cycle) => (
                  <option key={cycle} value={cycle}>
                    {locale === 'zh-CN'
                      ? ({ monthly: '月付', quarterly: '季付', semiannual: '半年付', annual: '年付', biennial: '两年付', triennial: '三年付', onetime: '一次性' } as const)[cycle]
                      : ({ monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semi-annual', annual: 'Annual', biennial: 'Biennial', triennial: 'Triennial', onetime: 'One-time' } as const)[cycle]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '月流量配额 (GB)' : 'Monthly Quota (GB)'}</label>
              <Input
                data-testid="host-billing-traffic"
                disabled={disabled}
                type="number"
                min="0"
                step="1"
                value={value.monthlyTrafficGb}
                onChange={(e) => onChange({ ...value, monthlyTrafficGb: e.target.value })}
                placeholder="1000"
                className="h-8 font-mono text-xs"
              />
            </div>
            <label className="flex h-8 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value.autoRenew}
                onChange={(e) => onChange({ ...value, autoRenew: e.target.checked })}
              />
              <span>{locale === 'zh-CN' ? '开启自动续费' : 'Auto-renew enabled'}</span>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
