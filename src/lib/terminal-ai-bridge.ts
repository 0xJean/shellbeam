import type { Terminal } from '@xterm/xterm'
import { OUTPUT_LINE_LIMIT, classifyTerminalTail, type TerminalAiBridge, type TerminalTail } from './ai-conversation'

const toTerminalInput = (command: string) => command.replace(/\n+$/, '').replace(/\n/g, '\r')
/** Multi-line prompts (starship, powerlevel10k) put a few lines above the input line. */
const MAX_PROMPT_HEADER = 3

const SHARED_PROMPT_CHARS = 12

/** Same prompt line, allowing the directory at its start or a duration at its end to have changed. */
function samePromptLine(a: string, b: string): boolean {
  const x = a.trimEnd()
  const y = b.trimEnd()
  if (x === y) return true
  // Longest run of text both lines share, e.g. the user, host or toolchain segments of the prompt.
  let longest = 0
  let previous = new Array<number>(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    const current = new Array<number>(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) { current[j] = previous[j - 1] + 1; longest = Math.max(longest, current[j]) }
    }
    previous = current
  }
  return longest >= SHARED_PROMPT_CHARS
}

/** Runs AI commands in an xterm session and reads back what the terminal printed after them. */
export function createTerminalAiBridge(getTerm: () => Terminal | null, send: (data: string) => void, recentOutput: (rows: number) => string): TerminalAiBridge {
  return {
    run(command) {
      const term = getTerm()
      const buf = term?.buffer.active
      // What sits before the cursor now is the prompt; its last character tells when the shell is back.
      const prompt = buf ? (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true, 0, buf.cursorX) ?? '') : ''
      const marker = term?.registerMarker(0)
      send(`${toTerminalInput(command)}\r`)
      const tail = (): { row: number; status: TerminalTail } => {
        if (!term || !marker || marker.isDisposed || marker.line < 0) return { row: -1, status: 'unknown' }
        const active = term.buffer.active
        const row = active.baseY + active.cursorY
        return { row, status: classifyTerminalTail(prompt, active.getLine(row)?.translateToString(true) ?? '', row > marker.line) }
      }
      return {
        read() {
          if (!term) return ''
          if (!marker || marker.isDisposed || marker.line < 0) return recentOutput(OUTPUT_LINE_LIMIT)
          const active = term.buffer.active
          // The marker line is the prompt with the echoed command; output starts below it and ends before a returned prompt.
          const { row, status } = tail()
          let end = status === 'prompt' ? row : active.length
          if (status === 'prompt') {
            // Lines above the returned prompt that match the lines above the original one belong to the prompt, not the output.
            // Compare whole lines: a long prompt line wraps onto several rows.
            const startOf = (i: number) => { while (i > 0 && active.getLine(i)?.isWrapped) i--; return i }
            const text = (from: number, to: number) => {
              let joined = ''
              for (let i = from; i < to; i++) joined += active.getLine(i)?.translateToString(true) ?? ''
              return joined
            }
            end = startOf(end)
            let before = startOf(marker.line)
            for (let j = 0; j < MAX_PROMPT_HEADER && end - 1 > marker.line && before > 0; j++) {
              const lineStart = startOf(end - 1)
              const prevStart = startOf(before - 1)
              if (lineStart <= marker.line || !samePromptLine(text(lineStart, end), text(prevStart, before))) break
              end = lineStart
              before = prevStart
            }
          }
          const lines: string[] = []
          for (let i = marker.line + 1; i < end; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
          return lines.join('\n').replace(/\n+$/, '')
        },
        onOutput(listener) {
          const subscription = term?.onWriteParsed(listener)
          return () => subscription?.dispose()
        },
        status: () => tail().status,
        dispose: () => marker?.dispose(),
      }
    },
    insert: (command) => send(toTerminalInput(command)),
    recentOutput,
    clear: () => getTerm()?.clear(),
    interrupt: () => send('\x03'),
  }
}
