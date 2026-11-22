import { describe, expect, it } from 'vitest'
import { buildFileBackupPlan, detectModifiedFileTargets } from './ai-file-backup'

describe('ai-file-backup', () => {
  it('returns no targets for read-only commands', () => {
    expect(detectModifiedFileTargets('cat /etc/nginx/nginx.conf')).toEqual([])
    expect(detectModifiedFileTargets('grep -n server /etc/nginx/nginx.conf')).toEqual([])
  })

  it('detects file targets for sed -i, tee, redirects, cp, mv, and rm', () => {
    expect(detectModifiedFileTargets("sudo sed -i 's/80/8080/g' /etc/nginx/sites-enabled/default")).toEqual([
      '/etc/nginx/sites-enabled/default',
    ])
    expect(detectModifiedFileTargets('echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf')).toEqual([
      '/etc/resolv.conf',
    ])
    expect(detectModifiedFileTargets('cat <<EOF > /etc/sysctl.d/99-bbr.conf\nnet.core.default_qdisc=fq\nEOF')).toEqual([
      '/etc/sysctl.d/99-bbr.conf',
    ])
    expect(detectModifiedFileTargets('cp /tmp/new.conf /etc/ssh/sshd_config')).toEqual([
      '/etc/ssh/sshd_config',
    ])
    expect(detectModifiedFileTargets('rm -f /etc/nginx/conf.d/old.conf')).toEqual([
      '/etc/nginx/conf.d/old.conf',
    ])
  })

  it('ignores /dev/null and dynamic shell expansions', () => {
    expect(detectModifiedFileTargets('echo ok > /dev/null')).toEqual([])
    expect(detectModifiedFileTargets('rm -rf /tmp/$TARGET')).toEqual([])
  })

  it('builds a POSIX backup wrapper with 3-copy retention and matching rollback command', () => {
    const fixedNow = Date.UTC(2026, 10, 22, 14, 30, 5)
    const plan = buildFileBackupPlan("sed -i 's/foo/bar/' /etc/nginx/nginx.conf", fixedNow)
    expect(plan).not.toBeNull()
    expect(plan!.stamp).toBe('20261122_143005')
    expect(plan!.targets).toEqual(['/etc/nginx/nginx.conf'])
    expect(plan!.wrappedCommand).toContain('mkdir -p "$HOME/.shellbeam-backups"')
    expect(plan!.wrappedCommand).toContain('cp -p \'/etc/nginx/nginx.conf\' "$HOME/.shellbeam-backups/20261122_143005_etc_nginx_nginx.conf"')
    expect(plan!.wrappedCommand).toContain('tail -n +4')
    expect(plan!.wrappedCommand).toContain("&& (sed -i 's/foo/bar/' /etc/nginx/nginx.conf)")
    expect(plan!.rollbackCommand).toBe(
      '[ -f "$HOME/.shellbeam-backups/20261122_143005_etc_nginx_nginx.conf" ] && cp -p "$HOME/.shellbeam-backups/20261122_143005_etc_nginx_nginx.conf" \'/etc/nginx/nginx.conf\'',
    )
  })
})
