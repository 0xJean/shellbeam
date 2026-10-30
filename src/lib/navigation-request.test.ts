import { describe, expect, it } from 'vitest'
import { consumeSftpRequest, requestHostSftp, shellQuote } from './navigation-request'

describe('navigation requests', () => {
  it('quotes directories so they are never read as shell syntax', () => {
    expect(shellQuote('/opt/app')).toBe("'/opt/app'")
    expect(shellQuote("/srv/it's here; rm -rf /")).toBe("'/srv/it'\\''s here; rm -rf /'")
    expect(shellQuote('$(id)`x`')).toBe("'$(id)`x`'")
  })

  it('hands an SFTP path only to the requested host, once', () => {
    requestHostSftp({ hostId: 'h1', path: '/opt/app' })
    expect(consumeSftpRequest('h2')).toBeNull()
    expect(consumeSftpRequest('h1')).toBe('/opt/app')
    expect(consumeSftpRequest('h1')).toBeNull()
  })
})
