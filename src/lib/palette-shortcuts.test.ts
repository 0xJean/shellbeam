import { describe, expect, it } from 'vitest'
import { paletteShortcutAction } from './palette-shortcuts'

const key = (patch: Partial<KeyboardEvent> & { target?: Element | null }) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: document.body, ...patch }) as KeyboardEvent

describe('palette shortcuts', () => {
  it('maps the shortcuts shown in the command palette', () => {
    expect(paletteShortcutAction(key({ ctrlKey: true, key: 'n' }))).toBe('focus-interactive')
    expect(paletteShortcutAction(key({ shiftKey: true, altKey: true, code: 'KeyF', key: 'Ï' }))).toBe('focus-sftp')
    expect(paletteShortcutAction(key({ metaKey: true, key: ',' }))).toBe('focus-settings')
    expect(paletteShortcutAction(key({ metaKey: true, key: 'n' }))).toBeNull()
  })

  it('never steals keys from the terminal or text fields', () => {
    const terminal = document.createElement('div'); terminal.className = 'xterm'
    const inner = document.createElement('textarea'); terminal.appendChild(inner)
    const input = document.createElement('input')
    expect(paletteShortcutAction(key({ ctrlKey: true, key: 'n', target: inner }))).toBeNull()
    expect(paletteShortcutAction(key({ metaKey: true, key: ',', target: input }))).toBeNull()
  })
})
