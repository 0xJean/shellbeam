import { describe, expect, it } from 'vitest'
import { classifyHostAddress } from './ip-metadata'

describe('IP metadata classifier', () => {
  it('marks RFC1918 addresses as private IPv4', () => {
    expect(classifyHostAddress('10.0.0.15')).toMatchObject({
      addressType: 'ipv4',
      scope: 'private',
      versionLabel: 'IPv4',
      scopeLabel: '内网 IP',
      locationLabel: '内网',
      canLookupLocation: false,
    })
  })

  it('marks public addresses as public and location lookup candidates', () => {
    expect(classifyHostAddress('8.8.8.8')).toMatchObject({
      addressType: 'ipv4',
      scope: 'public',
      versionLabel: 'IPv4',
      scopeLabel: '公网 IP',
      publicIp: '8.8.8.8',
      canLookupLocation: true,
    })
  })

  it('classifies hostnames without treating them as public IPs', () => {
    expect(classifyHostAddress('aicz.example.com')).toMatchObject({
      addressType: 'domain',
      scope: 'domain',
      versionLabel: '域名',
      scopeLabel: '域名',
      locationLabel: '域名需解析',
      canLookupLocation: false,
    })
  })

  it('handles bracketed IPv6 and IPv4 addresses with ports', () => {
    expect(classifyHostAddress('10.0.0.15:22')).toMatchObject({ address: '10.0.0.15', scope: 'private' })
    expect(classifyHostAddress('[fd12::1]:22')).toMatchObject({ address: 'fd12::1', addressType: 'ipv6', scope: 'private' })
  })
})
