import { describe, expect, it } from 'vitest'
import { autoRunAllowed, canRunSilently, classifyTerminalTail, formatExecOutput, loadRunMode, parseQuestion, saveRunMode, extractSuggestion, nextStepTip, splitReply, buildHistory, currentModelTarget, historyToMessages, isNoteReply, noteText, outputLooksFailed, trimCapturedOutput, withModel, type AITurn } from './ai-conversation'
import { DEFAULT_AI_SETTINGS } from './ai'

describe('ai conversation', () => {
  it('keeps both the head and tail of long output and counts every line', () => {
    const raw = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n\n'
    const { text, lineCount } = trimCapturedOutput(raw)
    expect(lineCount).toBe(300)
    expect(text.startsWith('line 0\nline 1')).toBe(true)
    expect(text).toContain('… (100 middle lines omitted; showing first 30 and last 170 of 300 lines)')
    expect(text.endsWith('line 299')).toBe(true)

    const longChars = `${'H'.repeat(5000)}\n${'M'.repeat(10000)}\n${'T'.repeat(5000)}`
    const trimmed = trimCapturedOutput(longChars)
    expect(trimmed.text.startsWith('HHH')).toBe(true)
    expect(trimmed.text).toContain('chars omitted')
    expect(trimmed.text.endsWith('TTT')).toBe(true)
  })

  it('builds history from finished turns only and keeps the newest when over budget', () => {
    const turns: AITurn[] = [
      { id: '1', kind: 'user', text: 'disk usage' },
      { id: '2', kind: 'ai', text: 'df -h', model: 'm' },
      { id: '3', kind: 'run', command: 'df -h', state: 'captured', output: '/ 41%', lineCount: 1 },
      { id: '4', kind: 'run', command: 'top', state: 'running', output: '', lineCount: 0 },
      { id: '5', kind: 'run', command: 'ls', state: 'sent', output: '', lineCount: 0 },
      { id: '6', kind: 'error', text: 'failed' },
    ]
    expect(buildHistory(turns)).toEqual([
      { role: 'user', content: 'disk usage' },
      { role: 'assistant', content: 'df -h' },
      { role: 'output', content: '$ df -h\n/ 41%' },
    ])
    const big = Array.from({ length: 60 }, (_, i): AITurn => ({ id: String(i), kind: 'user', text: `${i}`.padEnd(2000, '.') }))
    const kept = buildHistory(big)
    expect(kept.length).toBe(30)
    expect(kept[kept.length - 1].content.startsWith('59')).toBe(true)
  })

  it('turns history into alternating chat messages with output marked as data', () => {
    const messages = historyToMessages([
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'disk usage' },
      { role: 'assistant', content: 'df -h' },
      { role: 'output', content: '$ df -h\n/ 41%' },
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2].content).toContain('untrusted data')
  })

  it('recognises note replies and failure output', () => {
    expect(isNoteReply('# done\n# nothing else')).toBe(true)
    expect(isNoteReply('# list\nls')).toBe(false)
    expect(noteText('# a\n#b')).toBe('a\nb')
    expect(splitReply('# check ports\nss -tlnp\n# keep')).toEqual({ caption: 'check ports', command: 'ss -tlnp\n# keep' })
    expect(splitReply('ls')).toEqual({ caption: '', command: 'ls' })
    expect(outputLooksFailed('bash: foo: command not found')).toBe(true)
    expect(outputLooksFailed('total 12')).toBe(false)
  })

  it('reports and changes the model for API and CLI backends', () => {
    expect(currentModelTarget(DEFAULT_AI_SETTINGS)).toEqual({ backend: 'api', providerName: 'OpenAI', model: 'gpt-6.2-sol', effort: '', bucketKey: 'api:openai' })
    const claude = withModel({ ...DEFAULT_AI_SETTINGS, backend: 'claude-code' }, 'opus')
    expect(currentModelTarget(claude)).toEqual({ backend: 'claude-code', providerName: 'Claude Code', model: 'opus', effort: '', bucketKey: 'claude-code' })
    expect(claude.recentModels?.['claude-code']).toEqual(['opus'])
    expect(withModel({ ...DEFAULT_AI_SETTINGS, provider: 'custom' }, 'x').customModel).toBe('x')
  })

  it('separates the next-step line and picks the tip to offer', () => {
    expect(extractSuggestion('# check\ndf -h\n#> Find what fills the disk')).toEqual({ body: '# check\ndf -h', suggestion: 'Find what fills the disk' })
    expect(extractSuggestion('ls')).toEqual({ body: 'ls', suggestion: '' })
    const prompts = { next: 'NEXT', fix: 'FIX' }
    const ai: AITurn = { id: 'a', kind: 'ai', text: 'df -h', model: 'm', suggestion: 'Find what fills the disk' }
    expect(nextStepTip([ai], prompts)).toBe('Find what fills the disk')
    const run: AITurn = { id: 'r', kind: 'run', command: 'df -h', state: 'captured', output: '/ 92%', lineCount: 1 }
    expect(nextStepTip([ai, run], prompts)).toBe('Find what fills the disk')
    expect(nextStepTip([{ ...ai, suggestion: undefined }, run], prompts)).toBe('NEXT')
    expect(nextStepTip([{ ...ai, suggestion: undefined }, { ...run, output: 'permission denied' }], prompts)).toBe('FIX')
    expect(nextStepTip([ai, { id: 'u', kind: 'user', text: 'x' }], prompts)).toBe('')
  })

  it('lets each run mode auto-run only what it allows', () => {
    expect(autoRunAllowed('confirm', 'df -h')).toBe(false)
    expect(autoRunAllowed('read-only', 'df -h')).toBe(true)
    expect(autoRunAllowed('read-only', 'sudo systemctl restart nginx')).toBe(false)
    expect(autoRunAllowed('auto', 'sudo systemctl restart nginx')).toBe(true)
    expect(autoRunAllowed('auto', 'rm -rf /var/www')).toBe(false)
    expect(autoRunAllowed('read-only', 'tail -n 50 f')).toBe(true)
  })

  it('never auto-runs a command carrying a carriage return', () => {
    for (const mode of ['read-only', 'auto'] as const) {
      expect(autoRunAllowed(mode, 'echo a\rrm -rf /tmp/x')).toBe(false)
      expect(autoRunAllowed(mode, 'ls -l\rtouch /tmp/x')).toBe(false)
    }
  })

  it('stores the run mode per host and defaults to confirm', () => {
    localStorage.clear()
    expect(loadRunMode('v:h')).toBe('confirm')
    saveRunMode('v:h', 'auto')
    expect(loadRunMode('v:h')).toBe('auto')
    expect(loadRunMode('v:other')).toBe('confirm')
    saveRunMode('v:h', 'confirm')
    expect(localStorage.getItem('shellbeam.aiRunMode.v:h')).toBeNull()
  })

  it('reads a question and its choices', () => {
    expect(parseQuestion('# Two sites found\n#? Which one should I reload?\n#- example.com\n#- api.example.com')).toEqual({ notes: 'Two sites found', question: 'Which one should I reload?', options: ['example.com', 'api.example.com'] })
    expect(parseQuestion('# done')).toBeNull()
  })

  it('tells a returned prompt from a question or a busy command', () => {
    expect(classifyTerminalTail('deploy@web:~$ ', 'deploy@web:~$', true)).toBe('prompt')
    expect(classifyTerminalTail('deploy@web:~$ ', 'deploy@web:/var/log$', true)).toBe('prompt')
    expect(classifyTerminalTail('deploy@web:~$ ', 'deploy@web:~$ df -h', false)).toBe('busy')
    expect(classifyTerminalTail('deploy@web:~$ ', 'Do you want to continue? [Y/n]', true)).toBe('input')
    expect(classifyTerminalTail('deploy@web:~$ ', '[sudo] password for deploy:', true)).toBe('input')
    expect(classifyTerminalTail('deploy@web:~$ ', 'Unpacking nginx (1.24) ...', true)).toBe('busy')
    expect(classifyTerminalTail('', 'anything', true)).toBe('unknown')
  })

  it('decides which commands are safe and bounded for silent SSH exec', () => {
    expect(canRunSilently('df -h')).toBe(true)
    expect(canRunSilently('grep error /var/log/syslog | tail -n 50')).toBe(true)
    expect(canRunSilently('top -bn1')).toBe(true)
    expect(canRunSilently('docker stats --no-stream')).toBe(true)
    expect(canRunSilently('docker logs --since 24h pg 2>&1 | awk \'{c++} END{print c}\'')).toBe(true)

    expect(canRunSilently('cd /var/log')).toBe(false)
    expect(canRunSilently('pwd')).toBe(false)
    expect(canRunSilently('sudo nginx -t')).toBe(false)
    expect(canRunSilently('tail -f /var/log/syslog')).toBe(false)
    expect(canRunSilently('journalctl -f')).toBe(false)
    expect(canRunSilently('docker logs -f api')).toBe(false)
    expect(canRunSilently('docker stats')).toBe(false)
    expect(canRunSilently('htop')).toBe(false)
    expect(canRunSilently('top')).toBe(false)
    expect(canRunSilently('systemctl restart nginx')).toBe(false)
    expect(canRunSilently('rm -rf /tmp/x')).toBe(false)
  })

  it('includes real exit codes for silent exec in history and respects explicit outcome in nextStepTip', () => {
    expect(formatExecOutput({ stdout: 'ok\n', stderr: 'warn\n' })).toBe('ok\n[stderr]\nwarn')
    const turns: AITurn[] = [
      { id: 'u1', kind: 'user', text: 'check errors' },
      { id: 'a1', kind: 'ai', text: 'grep error app.log', model: 'm' },
      { id: 'r1', kind: 'run', command: 'grep error app.log', state: 'captured', via: 'exec', exitCode: 0, outcome: 'ok', output: '2026 error timeout', lineCount: 1 },
    ]
    expect(buildHistory(turns)).toContainEqual({
      role: 'output',
      content: '$ grep error app.log\n[exit code: 0]\n2026 error timeout',
    })
    expect(nextStepTip(turns, { next: 'NEXT', fix: 'FIX' })).toBe('NEXT')
  })
})
