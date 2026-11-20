import { describe, expect, it } from 'vitest'
import { isGitHostingHost, type SshConfigEntry } from './hosts'

describe('isGitHostingHost', () => {
  it('filters out GitHub multi-account aliases', () => {
    const entries: SshConfigEntry[] = [
      { alias: '0xJean', hostName: 'github.com', user: 'git', port: 22, identityFile: '~/.ssh/id_0xjean', proxyJump: null },
      { alias: 'UstarPay', hostName: 'github.com', user: 'git', port: 22, identityFile: '~/.ssh/id_ustarpay', proxyJump: null },
      { alias: 'zorojean318', hostName: 'github.com', user: 'git', port: 22, identityFile: '~/.ssh/id_zorojean', proxyJump: null },
      { alias: 'github.com', hostName: null, user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'github-custom', hostName: 'ssh.github.com', user: 'git', port: 443, identityFile: null, proxyJump: null },
    ]

    for (const entry of entries) {
      expect(isGitHostingHost(entry)).toBe(true)
    }
  })

  it('filters out other popular Git code hosting platforms', () => {
    const entries: SshConfigEntry[] = [
      { alias: 'gitlab-work', hostName: 'gitlab.com', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'gitee-personal', hostName: 'gitee.com', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'bitbucket-org', hostName: 'bitbucket.org', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'codeberg-org', hostName: 'codeberg.org', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'azure-devops', hostName: 'ssh.dev.azure.com', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'aws-git', hostName: 'git-codecommit.us-east-1.amazonaws.com', user: 'git', port: 22, identityFile: null, proxyJump: null },
      { alias: 'custom-internal-gitlab', hostName: 'gitlab.internal.corp', user: 'git', port: 22, identityFile: null, proxyJump: null },
    ]

    for (const entry of entries) {
      expect(isGitHostingHost(entry)).toBe(true)
    }
  })

  it('keeps genuine SSH server hosts intact', () => {
    const entries: SshConfigEntry[] = [
      { alias: 'prod-vps', hostName: '192.168.1.100', user: 'root', port: 22, identityFile: null, proxyJump: null },
      { alias: 'app-server', hostName: 'app.example.com', user: 'ubuntu', port: 2222, identityFile: '~/.ssh/id_rsa', proxyJump: null },
      { alias: 'bastion', hostName: 'bastion.corp.net', user: 'ops', port: 22, identityFile: null, proxyJump: null },
      { alias: 'dev-box', hostName: 'dev.local', user: 'developer', port: 22, identityFile: null, proxyJump: null },
    ]

    for (const entry of entries) {
      expect(isGitHostingHost(entry)).toBe(false)
    }
  })
})
