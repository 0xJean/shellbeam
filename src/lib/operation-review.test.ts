import { describe, expect, it } from 'vitest'
import { hostOperationReview } from './operation-review'
import type { HostProfile } from './hosts'

const host = { id: 'host', name: 'Production', address: '10.0.0.8', port: 2222, username: 'ops', authType: 'password', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile
it('identifies the host, route and actual command while unresolved references never reuse copied endpoints', () => {
  localStorage.setItem('shellbeam.locale', 'en')
  const review = hostOperationReview({ ...host, jumpHostId: 'vault-jump', jumpHost: 'obsolete.invalid', jumpUser: 'old-user', jumpPort: 2200 }, "docker restart 'abc123'")
  expect(review).toContain('Production · ops@10.0.0.8:2222')
  expect(review).toContain('ProxyJump host reference vault-jump')
  expect(review).toContain("Command summary: docker restart 'abc123'")
  expect(review).not.toContain('obsolete.invalid')
  expect(review).not.toContain('old-user')
})
describe.each(['en', 'zh-CN'])('confirmation summary locale %s', (locale) => {
  it('renders translated direct-host summaries without unrelated workflow warnings', () => {
    localStorage.setItem('shellbeam.locale', locale)
    const review = hostOperationReview(host, 'certbot renew --non-interactive')
    expect(review).toContain(locale === 'en' ? 'Route: Direct' : '连接路径：直连')
    expect(review).not.toMatch(/sudo|package/i)
  })
})
