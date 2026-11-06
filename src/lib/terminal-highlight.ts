import type { IBufferLine, IDecoration, IDisposable, IMarker, ITheme, Terminal } from '@xterm/xterm'

/**
 * Colours words that matter in plain terminal output (failures, warnings,
 * successes, addresses), so `journalctl`, `tail -f` or `docker logs` read at
 * a glance. Only text the program printed without a colour of its own is
 * coloured: a program's own colours always win. Full-screen programs (the
 * alternate screen: vim, htop) are left alone.
 */

export type HighlightSlot = 'red' | 'yellow' | 'green' | 'cyan'
export interface HighlightMatch { start: number; end: number; slot: HighlightSlot }

const words = (...list: string[]) => new RegExp(String.raw`(?<![\w-])(?:${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\w-])`, 'gi')

/** In order: the first rule to claim a character keeps it. */
const RULES: { slot: HighlightSlot; pattern: RegExp }[] = [
  { slot: 'red', pattern: words('error', 'errors', 'err', 'fail', 'fails', 'failed', 'failure', 'fatal', 'panic', 'denied', 'refused', 'critical', 'crit', 'emerg', 'exception', 'traceback', 'segfault', 'segmentation fault', 'oom', 'unreachable') },
  { slot: 'yellow', pattern: words('warn', 'warning', 'warnings', 'deprecated', 'timeout', 'timed out', 'retry', 'retrying', 'degraded') },
  { slot: 'green', pattern: words('ok', 'success', 'successful', 'successfully', 'succeeded', 'passed', 'done', 'connected', 'active (running)', 'healthy') },
  { slot: 'cyan', pattern: /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?(?![\w.])/g },
]

/** The highlighted ranges of one line of text, in order, never overlapping. */
export function matchHighlights(text: string): HighlightMatch[] {
  if (!text.trim()) return []
  const claimed: (HighlightSlot | undefined)[] = []
  const found: HighlightMatch[] = []
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      let free = true
      for (let i = start; i < end; i += 1) if (claimed[i]) { free = false; break }
      if (!free) continue
      for (let i = start; i < end; i += 1) claimed[i] = rule.slot
      found.push({ start, end, slot: rule.slot })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

const FALLBACK: Record<HighlightSlot, string> = { red: '#f14c4c', yellow: '#f5f543', green: '#23d18b', cyan: '#29b8db' }
const THEME_KEY: Record<HighlightSlot, keyof ITheme> = { red: 'brightRed', yellow: 'brightYellow', green: 'brightGreen', cyan: 'brightCyan' }

/** The bright ANSI colours of the theme, which every theme keeps readable on its background. */
export function highlightColors(theme: ITheme | undefined): Record<HighlightSlot, string> {
  const pick = (slot: HighlightSlot) => {
    const value = theme?.[THEME_KEY[slot]]
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : FALLBACK[slot]
  }
  return { red: pick('red'), yellow: pick('yellow'), green: pick('green'), cyan: pick('cyan') }
}

/** The line's text with, for each character, the column it starts in. Wide characters take two columns. */
function lineText(line: IBufferLine, cols: number): { text: string; columns: number[] } {
  let text = ''
  const columns: number[] = []
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i += 1) columns.push(x)
    text += chars
  }
  return { text, columns }
}

/** Lines scanned per write; a burst larger than this colours only its last lines. */
const MAX_LINES_PER_PASS = 400

export interface KeywordHighlighter extends IDisposable {
  setEnabled(enabled: boolean): void
}

export function attachKeywordHighlight(term: Terminal, options: { enabled: boolean }): KeywordHighlighter {
  let enabled = options.enabled
  /** The last line already coloured, as a marker so it follows scrollback trimming. */
  let scanned: IMarker | undefined
  const decorations = new Set<IDecoration>()

  const decorate = (marker: IMarker, x: number, width: number, color: string) => {
    const decoration = term.registerDecoration({ marker, x, width, foregroundColor: color, layer: 'top' })
    if (!decoration) return
    decorations.add(decoration)
    decoration.onDispose(() => decorations.delete(decoration))
  }

  const scan = () => {
    if (!enabled) return
    const buffer = term.buffer.active
    if (buffer.type !== 'normal') return
    const cursorLine = buffer.baseY + buffer.cursorY
    // The cursor's own line may still be written to; it is coloured once the output moves past it.
    const last = cursorLine - 1
    let from = scanned && !scanned.isDisposed ? scanned.line + 1 : Math.max(0, last - MAX_LINES_PER_PASS + 1)
    if (from < 0) from = 0
    if (last < from) return
    from = Math.max(from, last - MAX_LINES_PER_PASS + 1)
    const colors = highlightColors(term.options.theme)
    for (let y = from; y <= last; y += 1) {
      const line = buffer.getLine(y)
      if (!line) continue
      const { text, columns } = lineText(line, term.cols)
      const matches = matchHighlights(text)
      if (!matches.length) continue
      let marker: IMarker | undefined
      for (const match of matches) {
        // Colour only the runs of the match that the program left uncoloured.
        let runStart = -1
        const flush = (endColumn: number) => {
          if (runStart < 0) return
          marker ??= term.registerMarker(y - cursorLine)
          if (marker) decorate(marker, runStart, endColumn - runStart, colors[match.slot])
          runStart = -1
        }
        for (let i = match.start; i < match.end; i += 1) {
          const x = columns[i]
          if (i > match.start && x === columns[i - 1]) continue
          const cell = line.getCell(x)
          const plain = !!cell && cell.isFgDefault() && !cell.isInverse()
          if (plain && runStart < 0) runStart = x
          if (!plain) flush(x)
        }
        const lastColumn = columns[match.end - 1]
        flush(lastColumn + (line.getCell(lastColumn)?.getWidth() ?? 1))
      }
    }
    scanned?.dispose()
    scanned = term.registerMarker(last - cursorLine)
  }

  const subscription = term.onWriteParsed(scan)

  const clear = () => {
    for (const decoration of [...decorations]) decoration.dispose()
    decorations.clear()
  }

  return {
    setEnabled(next: boolean) {
      if (next === enabled) return
      enabled = next
      if (!enabled) clear()
      // Turning it back on colours what arrives from now on, plus the screen in view.
      scanned?.dispose()
      scanned = enabled ? term.registerMarker(-(term.rows)) : undefined
      if (enabled) scan()
    },
    dispose() {
      subscription.dispose()
      scanned?.dispose()
      clear()
    },
  }
}
