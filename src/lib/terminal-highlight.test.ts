import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { attachKeywordHighlight, highlightColors, matchHighlights } from './terminal-highlight'

const words = (text: string) => matchHighlights(text).map((m) => [text.slice(m.start, m.end), m.slot])

describe('matchHighlights', () => {
  it('finds failures, warnings, successes and addresses as whole words', () => {
    expect(words('ERROR: connection refused by 10.0.1.12:5432')).toEqual([['ERROR', 'red'], ['refused', 'red'], ['10.0.1.12:5432', 'cyan']])
    expect(words('[WARN] request timed out, retrying')).toEqual([['WARN', 'yellow'], ['timed out', 'yellow'], ['retrying', 'yellow']])
    expect(words('nginx.service: active (running) since Tue')).toEqual([['active (running)', 'green']])
    expect(words('Tests passed: 12, failed: 0')).toEqual([['passed', 'green'], ['failed', 'red']])
  })

  it('leaves parts of words, paths and version numbers alone', () => {
    expect(words('stderr errorlog /var/log/error-pages terror')).toEqual([])
    expect(words('version 1.2.3.4.5 and 999.1.1.1')).toEqual([])
    expect(words('')).toEqual([])
  })
})

describe('highlightColors', () => {
  it('uses the theme’s bright colours and falls back for missing or unusable ones', () => {
    const colors = highlightColors({ brightRed: '#ff0000', brightGreen: 'rgb(0,255,0)' })
    expect(colors.red).toBe('#ff0000')
    expect(colors.green).toMatch(/^#[0-9a-f]{6}$/i)
    expect(colors.green).not.toBe('rgb(0,255,0)')
  })
})

describe('attachKeywordHighlight', () => {
  const setup = (enabled = true) => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const decorations: { x?: number; width?: number; foregroundColor?: string }[] = []
    const register = term.registerDecoration.bind(term)
    term.registerDecoration = (options) => { decorations.push(options); return register(options) }
    const highlighter = attachKeywordHighlight(term, { enabled })
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve))
    return { term, decorations, highlighter, write }
  }

  it('colours only output the program left uncoloured', async () => {
    const { decorations, write, highlighter } = setup()
    await write('ERROR plain\r\n\x1b[31mERROR coloured\x1b[0m\r\n$ ')
    expect(decorations.map((d) => [d.x, d.width])).toEqual([[0, 5]])
    highlighter.dispose()
  })

  it('waits until the output moves past the line being written', async () => {
    const { decorations, write, highlighter } = setup()
    await write('job failed')
    expect(decorations).toHaveLength(0)
    await write('\r\n$ ')
    expect(decorations).toHaveLength(1)
    await write('\r\nok\r\n')
    expect(decorations).toHaveLength(2)
    highlighter.dispose()
  })

  it('leaves full-screen programs alone and can be turned off', async () => {
    const { decorations, write, highlighter } = setup()
    await write('\x1b[?1049h error in vim\r\nmore\r\n')
    expect(decorations).toHaveLength(0)
    await write('\x1b[?1049l')
    highlighter.setEnabled(false)
    await write('error\r\n$ ')
    expect(decorations).toHaveLength(0)
    highlighter.dispose()
  })
})
