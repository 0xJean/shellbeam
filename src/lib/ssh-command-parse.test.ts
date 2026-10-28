import { describe, expect, it } from 'vitest'
import { formatSshCommand, identityBaseName, parseSshCommand, parseSshEndpoint } from './ssh-command-parse'

describe('parseSshCommand', () => {
  it('reads user, host and port', () => {
    expect(parseSshCommand('ssh root@47.242.18.8 -p 22')).toEqual({ host: '47.242.18.8', username: 'root', port: 22 })
    expect(parseSshCommand('ssh web -p 2200 ls -p 1')).toEqual({ host: 'web', port: 2200 })
    expect(parseSshCommand('ssh -p 22 root@47.242.18.8')).toEqual({ host: '47.242.18.8', username: 'root', port: 22 })
    expect(parseSshCommand('  $ ssh -p2222 deploy@web.example.com uptime\nsecond line')).toEqual({ host: 'web.example.com', username: 'deploy', port: 2222 })
    expect(parseSshCommand('ssh db-01')).toEqual({ host: 'db-01' })
  })

  it('reads jump host, identity file and -o options', () => {
    expect(parseSshCommand('ssh -J ops@bastion:2200 -i ~/.ssh/id_ed25519_work -o StrictHostKeyChecking=no -o Port=2022 -l admin 10.0.3.12')).toEqual({
      host: '10.0.3.12', username: 'admin', port: 2022, jump: { host: 'bastion', username: 'ops', port: 2200 }, identityFile: '~/.ssh/id_ed25519_work',
    })
    expect(parseSshCommand('ssh -o ProxyJump=gw -tt "user@host.lan"')).toEqual({ host: 'host.lan', username: 'user', jump: { host: 'gw' } })
  })

  it('accepts ssh:// URIs and IPv6', () => {
    expect(parseSshCommand('ssh ssh://root@example.com:2201')).toEqual({ host: 'example.com', username: 'root', port: 2201 })
    expect(parseSshCommand('ssh -p 22 root@2001:db8::1')).toEqual({ host: '2001:db8::1', username: 'root', port: 22 })
  })

  it('rejects anything that is not a usable ssh command', () => {
    for (const text of ['', 'scp a b', 'ssh', 'ssh -p', 'ssh -p 99999 host', 'ssh -J a,b host', 'ssh root@host:22', 'ssh "unterminated', 'hello world', 'sshd -D', 'ssh @host', 'ssh bad_host!', `ssh ${'a'.repeat(1200)}`]) {
      expect(parseSshCommand(text), text).toBeNull()
    }
  })

  it('formats a confirmation label', () => {
    expect(formatSshCommand({ host: '47.242.18.8', username: 'root', port: 22 })).toBe('ssh root@47.242.18.8 -p 22')
    expect(formatSshCommand({ host: '::1', jump: { host: 'gw', username: 'ops', port: 2200 } })).toBe('ssh [::1] -J ops@gw:2200')
  })

  it('parses endpoints and identity names', () => {
    expect(parseSshEndpoint('[::1]:2022')).toEqual({ host: '::1', port: 2022 })
    expect(parseSshEndpoint('-oProxyCommand=x')).toBeNull()
    expect(identityBaseName('C:\\keys\\prod.pem')).toBe('prod')
    expect(identityBaseName('~/.ssh/id_ed25519_work')).toBe('id_ed25519_work')
  })
})
