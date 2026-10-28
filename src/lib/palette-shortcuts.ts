import type { CommandPaletteAction } from '@/contexts/app-context'

/**
 * Global shortcuts shown in the command palette. They never fire from the
 * terminal (Ctrl+N is the shell's next-history key) or from text fields.
 */
export function paletteShortcutAction(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>): CommandPaletteAction | null {
  const target = e.target as HTMLElement | null
  if (target?.closest?.('.xterm, input, textarea, select, [contenteditable="true"]')) return null
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') return 'focus-interactive'
  if (e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyF') return 'focus-sftp'
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') return 'focus-settings'
  return null
}
