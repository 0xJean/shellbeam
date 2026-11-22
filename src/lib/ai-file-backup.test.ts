import { describe, expect, it } from 'vitest'
import { buildFileBackupPlan, detectModifiedFileTargets, MAX_BACKUP_TARGETS } from './ai-file-backup'

describe('ai-file-backup', () => {
  const fixedNow = Date.UTC(2026, 10, 22, 14, 30, 5)

  it('returns no targets for read-only commands', () => {
    expect(detectModifiedFileTargets('cat /etc/nginx/nginx.conf')).toEqual([])
    expect(detectModifiedFileTargets('grep -n server /etc/nginx/nginx.conf')).toEqual([])
  })

  it('detects file targets for sed -i, tee, redirects, cp, mv, install with flags, truncate with flags, and rm', () => {
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
    expect(detectModifiedFileTargets('mv ./new.conf ./active.conf')).toEqual([
      './new.conf',
      './active.conf',
    ])
    expect(detectModifiedFileTargets('sudo install -m 0644 -o root ./app.conf /etc/my-app.conf')).toEqual([
      '/etc/my-app.conf',
    ])
    expect(detectModifiedFileTargets('truncate -s 0 ./app.log')).toEqual([
      './app.log',
    ])
    expect(detectModifiedFileTargets('rm -f /etc/nginx/conf.d/old.conf')).toEqual([
      '/etc/nginx/conf.d/old.conf',
    ])
  })

  it('resolves home-relative ~/ paths via $HOME and rejects unsupported ~user paths', () => {
    const plan = buildFileBackupPlan("sed -i 's/a/b/' ~/app.conf", fixedNow)
    expect(plan).not.toBeNull()
    expect(plan!.wrappedCommand).toContain('"$HOME"/\'app.conf\'')
    expect(plan!.rollbackCommand).toContain('"$HOME"/\'app.conf\'')
    expect(plan!.wrappedCommand).not.toContain("'~/app.conf'")

    expect(detectModifiedFileTargets("sed -i 's/a/b/' ~other/app.conf")).toEqual([])
  })

  it('fails closed on ambiguous moves/installs, dynamic expansions, and target counts above limit', () => {
    expect(detectModifiedFileTargets('echo ok > /dev/null')).toEqual([])
    expect(detectModifiedFileTargets('rm -rf /tmp/$TARGET')).toEqual([])
    expect(detectModifiedFileTargets('mv ./a.conf ./b.conf /etc/nginx/')).toEqual([])
    expect(detectModifiedFileTargets('mv -t /etc/nginx ./a.conf')).toEqual([])
    expect(detectModifiedFileTargets('mv ./a.conf /etc/nginx/')).toEqual([])
    expect(detectModifiedFileTargets('install -d /etc/my-app')).toEqual([])

    const tooMany = Array.from({ length: MAX_BACKUP_TARGETS + 1 }, (_, i) => `/etc/app/f${i}.conf`).join(' ')
    expect(detectModifiedFileTargets(`sed -i 's/a/b/' ${tooMany}`)).toEqual([])
  })

  it('runs each backup step inside a subshell and refuses symlinks and directories without exiting the session', () => {
    const plan = buildFileBackupPlan('cp ./nginx.conf /tmp/nginx.conf', fixedNow)
    expect(plan).not.toBeNull()
    expect(plan!.wrappedCommand).toContain('( if test -L')
    expect(plan!.wrappedCommand).toContain('Refusing backup (symlink): /tmp/nginx.conf')
    expect(plan!.wrappedCommand).toContain('Refusing backup (directory): /tmp/nginx.conf')
    expect(plan!.wrappedCommand).not.toContain('{ if')
  })

  it('prevents snapshot name collisions when different paths sanitize to the same slug', () => {
    const plan = buildFileBackupPlan('mv /tmp/app/config.ini /tmp/app_config.ini', fixedNow)
    expect(plan).not.toBeNull()
    const matches = plan!.wrappedCommand.match(/20261122_143005_[0-9a-f]{8}_tmp_app_config\.ini\.bak/g) ?? []
    const uniqueBackups = new Set(matches)
    expect(uniqueBackups.size).toBe(2)
  })

  it('preserves heredoc delimiters with newline-delimited subshell wrapping', () => {
    const cmd = 'cat <<EOF > /etc/sysctl.d/99-bbr.conf\nnet.core.default_qdisc=fq\nEOF'
    const plan = buildFileBackupPlan(cmd, fixedNow)
    expect(plan).not.toBeNull()
    expect(plan!.wrappedCommand).toContain('&& (\ncat <<EOF > /etc/sysctl.d/99-bbr.conf\nnet.core.default_qdisc=fq\nEOF\n)')
  })

  it('records absent markers for newly created files and restores multi-file runs independently', () => {
    const cmd = "echo 'x=1' > /tmp/new.conf && sed -i 's/a/b/' /tmp/existing.conf"
    const plan = buildFileBackupPlan(cmd, fixedNow)
    expect(plan).not.toBeNull()
    expect(plan!.targets).toEqual(['/tmp/new.conf', '/tmp/existing.conf'])
    expect(plan!.wrappedCommand).toContain('.absent')
    expect(plan!.rollbackCommand).toContain('rc=0')
    expect(plan!.rollbackCommand).toContain('.absent"; then rm -f \'/tmp/new.conf\'')
    expect(plan!.rollbackCommand).toContain('.bak" \'/tmp/existing.conf\'')
    expect(plan!.rollbackCommand).toContain('exit $rc')
  })

  it('inspects and restores elevated sudo targets with sudo without mutating original ownership', () => {
    const elevated = buildFileBackupPlan("sudo rm -f /etc/ssl/private/app.key", fixedNow)
    expect(elevated).not.toBeNull()
    expect(elevated!.usesSudo).toBe(true)
    expect(elevated!.wrappedCommand).toContain('sudo test -L')
    expect(elevated!.wrappedCommand).toContain('sudo test -x "$(dirname --')
    expect(elevated!.wrappedCommand).toContain('sudo test -f')
    expect(elevated!.wrappedCommand).toContain('sudo cp -p')
    expect(elevated!.wrappedCommand).not.toContain('chown')
    expect(elevated!.rollbackCommand).toContain('sudo test -f')
    expect(elevated!.rollbackCommand).toContain('sudo cp -p')
  })
})
