import type { Terminal } from '@xterm/xterm'
import { OUTPUT_LINE_LIMIT, classifyTerminalTail, type TerminalAiBridge, type TerminalTail } from './ai-conversation'

const toTerminalInput = (command: string) => command.replace(/\n+$/, '').replace(/\n/g, '\r')

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
          const end = status === 'prompt' ? row : active.length
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
