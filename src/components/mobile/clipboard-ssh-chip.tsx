import { useEffect, useState } from 'react'
import { ClipboardPaste, CircleCheck } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { mobileHostsCopy } from '@/lib/locales/mobile-hosts-v3'
import { cn } from '@/lib/utils'
import { formatSshCommand, parseSshCommand, type ParsedSshCommand } from '@/lib/ssh-command-parse'

type ChipState = { kind: 'idle' } | { kind: 'found'; command: ParsedSshCommand } | { kind: 'none' } | { kind: 'filled' } | { kind: 'hidden' }

const clipboardReadable = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

async function readClipboard() {
  try { return await navigator.clipboard.readText() } catch { return null }
}

/** Reads silently only where the clipboard permission is already granted. */
async function readClipboardIfGranted() {
  try {
    const status = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName })
    return status?.state === 'granted' ? await readClipboard() : null
  } catch {
    return null
  }
}

/**
 * Offers to fill the new-host form from an `ssh …` command on the clipboard.
 * Where reading needs a gesture (iOS WebKit, most browsers) nothing is read
 * until the chip is tapped; a denied read just hides the chip.
 */
export function ClipboardSshChip({ onApply }: { onApply: (command: ParsedSshCommand) => void }) {
  const { locale } = useT()
  const c = mobileHostsCopy[locale]
  const [state, setState] = useState<ChipState>({ kind: 'idle' })
  const readable = clipboardReadable()

  useEffect(() => {
    if (!readable) return
    let live = true
    void readClipboardIfGranted().then((text) => {
      const command = text ? parseSshCommand(text) : null
      if (live && command) setState((current) => current.kind === 'idle' ? { kind: 'found', command } : current)
    })
    return () => { live = false }
  }, [readable])

  if (!readable || state.kind === 'hidden') return null

  const apply = (command: ParsedSshCommand) => { onApply(command); setState({ kind: 'filled' }) }
  const paste = async () => {
    const text = await readClipboard()
    if (text === null) { setState({ kind: 'hidden' }); return }
    const command = parseSshCommand(text)
    if (command) apply(command)
    else setState({ kind: 'none' })
  }

  if (state.kind === 'filled') {
    return (
      <p data-testid="clipboard-ssh-filled" role="status" className="flex items-center gap-2 px-1 text-[13px] text-[color:var(--workspace-status-good-text)]">
        <CircleCheck className="h-4 w-4 shrink-0" />{c.clipboardFilled}
      </p>
    )
  }

  const found = state.kind === 'found' ? state.command : null
  return (
    <button type="button" data-testid="clipboard-ssh-chip" data-state={state.kind}
      onClick={() => { if (found) apply(found); else void paste() }}
      className="flex min-h-[52px] w-full items-center gap-3 rounded-xl bg-[var(--workspace-accent-subtle)] px-3.5 py-2.5 text-left">
      <ClipboardPaste className="h-[18px] w-[18px] shrink-0 text-[var(--workspace-accent-text)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-[var(--workspace-text-strong)]">{found ? c.clipboardDetected : c.clipboardPaste}</span>
        <span className={cn('block truncate text-[11.5px] text-[var(--workspace-text-muted)]', found && 'font-mono')}>
          {found ? formatSshCommand(found) : state.kind === 'none' ? c.clipboardNone : c.clipboardPasteHint}
        </span>
      </span>
      {found && <span className="shrink-0 text-[13px] font-semibold text-[var(--workspace-accent-text)]">{c.clipboardFill}</span>}
    </button>
  )
}
