export type BillingCurrency = 'CNY' | 'USD' | 'EUR' | 'HKD' | 'JPY' | 'GBP'
export type BillingCycle =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'biennial'
  | 'triennial'
  | 'onetime'

export interface HostBilling {
  provider?: string
  price?: number
  currency?: BillingCurrency | string
  cycle?: BillingCycle | string
  /** ISO calendar date `YYYY-MM-DD`. */
  expiresAt?: string
  monthlyTrafficGb?: number
  autoRenew?: boolean
}

export const BILLING_CURRENCIES: readonly BillingCurrency[] = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP']
export const BILLING_CYCLES: readonly BillingCycle[] = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
  'biennial',
  'triennial',
  'onetime',
]

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  HKD: 'HK$',
  JPY: '¥',
  GBP: '£',
}

const CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  biennial: 24,
  triennial: 36,
}

export type ExpiryStatus = 'expired' | 'urgent' | 'soon' | 'ok'

export interface HostExpiryInfo {
  expiresAt: string
  daysRemaining: number
  status: ExpiryStatus
}

export function currencySymbol(currency?: string | null): string {
  const code = currency?.trim().toUpperCase() || 'USD'
  return CURRENCY_SYMBOL[code] ?? `${code} `
}

/** Parse `YYYY-MM-DD` as a UTC midnight day index to avoid local timezone drift. */
function parseIsoCalendarDay(dateStr?: string | null): number | null {
  if (!dateStr) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = Date.UTC(year, month - 1, day)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  return Math.floor(utc / 86_400_000)
}

function localTodayDayIndex(now: number): number {
  const date = new Date(now)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

export function evaluateHostExpiry(billing?: HostBilling | null, now = Date.now()): HostExpiryInfo | null {
  const targetDay = parseIsoCalendarDay(billing?.expiresAt)
  if (targetDay === null || !billing?.expiresAt) return null
  const daysRemaining = targetDay - localTodayDayIndex(now)
  const status: ExpiryStatus = daysRemaining < 0
    ? 'expired'
    : daysRemaining <= 7
      ? 'urgent'
      : daysRemaining <= 30
        ? 'soon'
        : 'ok'
  return { expiresAt: billing.expiresAt.trim(), daysRemaining, status }
}

export function normalizeHostBilling(billing?: HostBilling | null): HostBilling | undefined {
  if (!billing) return undefined
  const provider = billing.provider?.trim() || undefined
  const currency = billing.currency?.trim().toUpperCase() || undefined
  const cycle = billing.cycle?.trim().toLowerCase() || undefined
  const expiresAt = parseIsoCalendarDay(billing.expiresAt) !== null ? billing.expiresAt?.trim() : undefined
  const price = typeof billing.price === 'number' && Number.isFinite(billing.price) && billing.price >= 0
    ? Math.round(billing.price * 100) / 100
    : undefined
  const monthlyTrafficGb = typeof billing.monthlyTrafficGb === 'number' && Number.isFinite(billing.monthlyTrafficGb) && billing.monthlyTrafficGb >= 0
    ? Math.round(billing.monthlyTrafficGb * 100) / 100
    : undefined
  const autoRenew = billing.autoRenew ? true : undefined
  if (!provider && price === undefined && !currency && !cycle && !expiresAt && monthlyTrafficGb === undefined && !autoRenew) {
    return undefined
  }
  return { provider, price, currency, cycle, expiresAt, monthlyTrafficGb, autoRenew }
}

export function monthlyEquivalentCost(billing?: HostBilling | null): number | null {
  if (!billing || typeof billing.price !== 'number' || !Number.isFinite(billing.price) || billing.price < 0) {
    return null
  }
  const cycle = billing.cycle?.trim().toLowerCase() || 'monthly'
  const months = CYCLE_MONTHS[cycle]
  if (!months) return null
  return billing.price / months
}

export interface FleetBillingSummary {
  trackedCount: number
  expiringCount: number
  expiredCount: number
  monthlyByCurrency: Array<{ currency: string; amount: number }>
}

export function summarizeFleetBilling(
  hosts: ReadonlyArray<{ billing?: HostBilling | null }>,
  now = Date.now(),
): FleetBillingSummary {
  let trackedCount = 0
  let expiringCount = 0
  let expiredCount = 0
  const byCurrency = new Map<string, number>()

  for (const host of hosts) {
    const billing = host.billing
    if (!billing) continue
    trackedCount += 1
    const expiry = evaluateHostExpiry(billing, now)
    if (expiry) {
      if (expiry.status === 'expired') {
        expiredCount += 1
        expiringCount += 1
      } else if (expiry.status === 'urgent' || expiry.status === 'soon') {
        expiringCount += 1
      }
    }
    const monthly = monthlyEquivalentCost(billing)
    if (monthly !== null && monthly > 0) {
      const code = billing.currency?.trim().toUpperCase() || 'USD'
      byCurrency.set(code, (byCurrency.get(code) ?? 0) + monthly)
    }
  }

  const monthlyByCurrency = [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency))

  return { trackedCount, expiringCount, expiredCount, monthlyByCurrency }
}

export function formatMoney(amount: number, currency?: string | null): string {
  const sym = currencySymbol(currency)
  const formatted = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.00$/, '')
  return `${sym}${formatted}`
}

export function formatBillingExpiryBadge(info: HostExpiryInfo, locale: 'en' | 'zh-CN'): string {
  if (info.daysRemaining < 0) {
    const overdue = Math.abs(info.daysRemaining)
    return locale === 'zh-CN' ? `已过期 ${overdue}天` : `Expired ${overdue}d`
  }
  if (info.daysRemaining === 0) {
    return locale === 'zh-CN' ? '今日到期' : 'Expires today'
  }
  return locale === 'zh-CN' ? `到期 ${info.daysRemaining}天` : `${info.daysRemaining}d left`
}

export function compareHostExpiry(
  a?: HostBilling | null,
  b?: HostBilling | null,
  now = Date.now(),
): number {
  const ea = evaluateHostExpiry(a, now)
  const eb = evaluateHostExpiry(b, now)
  if (!ea && !eb) return 0
  if (!ea) return 1
  if (!eb) return -1
  return ea.daysRemaining - eb.daysRemaining
}
