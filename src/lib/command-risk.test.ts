import { describe, expect, it } from 'vitest'
import { classifyCommandRisk } from './command-risk'

describe('classifyCommandRisk', () => {
  it.each([
    'ls -la /var/log',
    'sudo nginx -t && \\\nsudo journalctl -u nginx -n 20 --no-pager',
    'df -h / | tail -1',
    'docker ps --format "{{.Names}}\\t{{.Status}}"',
    'ps aux | grep nginx | head -5',
    'systemctl status nginx',
    'tail -f /var/log/syslog 2>&1',
    'find /var/log -name "*.gz" -mtime +7',
    'cat /etc/os-release > /dev/null',
    'du -sh /var/* 2>/dev/null | sort -rh | head -10',
    'docker compose logs -f api',
    'kubectl get pods -A',
    'git log --oneline -5',
    'ip -br a',
    'curl -sI https://example.com',
    'date +%F',
    '# check memory\nfree -m',
  ])('treats %s as read-only', (command) => {
    expect(classifyCommandRisk(command)).toBe('read-only')
  })

  it.each([
    'systemctl restart nginx',
    'echo hi > /etc/motd',
    'cat a | tee b',
    'mkdir -p /opt/app',
    'sed -i "s/a/b/" file.conf',
    'apt install -y htop',
    'ls $(cat list)',
    'echo `whoami`',
    'my-custom-script --flag',
    'curl -X POST https://example.com/api',
    'sudo -i',
    'find . -name "*.tmp" -exec chmod 600 {} \\;',
    'FOO=1',
    '',
    'echo "unterminated',
  ])('treats %s as changing state', (command) => {
    expect(classifyCommandRisk(command)).toBe('changes-state')
  })

  it.each([
    'rm -rf /var/www/old',
    'sudo rm /tmp/x',
    'ls && rm file',
    'docker system prune -af',
    'docker compose down -v',
    'kubectl delete pod web-1',
    'git reset --hard HEAD~1',
    'systemctl stop nginx',
    'find /tmp -name "*.log" -delete',
    'find . -type f -exec rm {} +',
    'psql -c "DROP TABLE users"',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'echo x > /dev/sda',
    'mkfs.ext4 /dev/vdb1',
    'crontab -r',
    'iptables -F',
    'apt purge nginx',
    'kill -9 1234',
  ])('treats %s as destructive', (command) => {
    expect(classifyCommandRisk(command)).toBe('destructive')
  })
})
