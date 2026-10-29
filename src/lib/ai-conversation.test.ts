import { describe, expect, it } from 'vitest'
import { autoRunAllowed, loadRunMode, parseQuestion, saveRunMode, extractSuggestion, nextStepTip, splitReply, buildHistory, currentModelTarget, historyToMessages, isNoteReply, noteText, outputLooksFailed, trimCapturedOutput, withModel, type AITurn } from './ai-conversation'
import { DEFAULT_AI_SETTINGS } from './ai'

describe('ai conversation', () => {
  it('keeps the tail of long output and counts every line', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n\n'
    const { text, lineCount } = trimCapturedOutput(raw)
    expect(lineCount).toBe(200)
    expect(text.startsWith('… (120 earlier lines omitted)')).toBe(true)
    expect(text.endsWith('line 199')).toBe(true)
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
    expect(currentModelTarget(DEFAULT_AI_SETTINGS)).toEqual({ backend: 'api', providerName: 'OpenAI', model: 'gpt-4o-mini' })
    const claude = withModel({ ...DEFAULT_AI_SETTINGS, backend: 'claude-code' }, 'opus')
    expect(currentModelTarget(claude)).toEqual({ backend: 'claude-code', providerName: 'Claude Code', model: 'opus' })
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
})
