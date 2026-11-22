import { describe, expect, it } from 'vitest'
import {
  compareHostExpiry,
  evaluateHostExpiry,
  formatBillingExpiryBadge,
  formatMoney,
  monthlyEquivalentCost,
  normalizeHostBilling,
  summarizeFleetBilling,
} from './host-billing'

describe('host-billing', () => {
  // 2026-11-22 12:00 local time
  const now = new Date(2026, 10, 22, 12, 0, 0).getTime()

  it('classifies expiry statuses accurately without off-by-one drift', () => {
    expect(evaluateHostExpiry({ expiresAt: '2026-11-20' }, now)).toEqual({
      expiresAt: '2026-11-20',
      daysRemaining: -2,
      status: 'expired',
    })
    expect(evaluateHostExpiry({ expiresAt: '2026-11-22' }, now)).toEqual({
      expiresAt: '2026-11-22',
      daysRemaining: 0,
      status: 'urgent',
    })
    expect(evaluateHostExpiry({ expiresAt: '2026-11-29' }, now)).toEqual({
      expiresAt: '2026-11-29',
      daysRemaining: 7,
      status: 'urgent',
    })
    expect(evaluateHostExpiry({ expiresAt: '2026-12-10' }, now)).toEqual({
      expiresAt: '2026-12-10',
      daysRemaining: 18,
      status: 'soon',
    })
    expect(evaluateHostExpiry({ expiresAt: '2027-03-01' }, now)?.status).toBe('ok')
    expect(evaluateHostExpiry({ expiresAt: '2026-02-31' }, now)).toBeNull()
  })

  it('normalizes empty billing drafts to undefined and cleans valid values', () => {
    expect(normalizeHostBilling({ provider: '  ', price: Number.NaN, autoRenew: false })).toBeUndefined()
    expect(normalizeHostBilling({
      provider: ' Bandwagon ',
      price: 49.995,
      currency: 'usd',
      cycle: 'Annual',
      expiresAt: '2027-01-15',
      monthlyTrafficGb: 1000,
      autoRenew: true,
    })).toEqual({
      provider: 'Bandwagon',
      price: 50,
      currency: 'USD',
      cycle: 'annual',
      expiresAt: '2027-01-15',
      monthlyTrafficGb: 1000,
      autoRenew: true,
    })
  })

  it('computes monthly equivalents and summarizes multi-currency fleet billing', () => {
    expect(monthlyEquivalentCost({ price: 120, cycle: 'annual' })).toBe(10)
    expect(monthlyEquivalentCost({ price: 300, cycle: 'onetime' })).toBeNull()

    const summary = summarizeFleetBilling([
      { billing: { price: 120, currency: 'USD', cycle: 'annual', expiresAt: '2026-11-25' } },
      { billing: { price: 5, currency: 'USD', cycle: 'monthly', expiresAt: '2027-06-01' } },
      { billing: { price: 240, currency: 'CNY', cycle: 'annual', expiresAt: '2026-11-10' } },
      { billing: undefined },
    ], now)

    expect(summary).toEqual({
      trackedCount: 3,
      expiringCount: 2,
      expiredCount: 1,
      monthlyByCurrency: [
        { currency: 'CNY', amount: 20 },
        { currency: 'USD', amount: 15 },
      ],
    })
  })

  it('formats money and expiry badges cleanly and sorts soonest expiry first', () => {
    expect(formatMoney(15, 'USD')).toBe('$15')
    expect(formatMoney(19.9, 'CNY')).toBe('¥19.90')
    expect(formatBillingExpiryBadge({ expiresAt: '2026-11-25', daysRemaining: 3, status: 'urgent' }, 'zh-CN')).toBe('到期 3天')
    expect(formatBillingExpiryBadge({ expiresAt: '2026-11-20', daysRemaining: -2, status: 'expired' }, 'en')).toBe('Expired 2d')

    const sorted = [
      { id: 'none', billing: undefined },
      { id: 'later', billing: { expiresAt: '2027-01-01' } },
      { id: 'soon', billing: { expiresAt: '2026-11-24' } },
    ].sort((a, b) => compareHostExpiry(a.billing, b.billing, now))
    expect(sorted.map((item) => item.id)).toEqual(['soon', 'later', 'none'])
  })
})
