import { useCallback, useState, type ReactNode } from 'react'

import { SnippetVariableDialog } from '@/components/snippet-variable-fill'
import { parseSnippetVariables } from '@/lib/snippet-variables'

interface PendingFill {
  command: string
  name?: string
  onReady: (command: string) => void
}

export function useSnippetVariableFill() {
  const [pending, setPending] = useState<PendingFill | null>(null)
  const [nonce, setNonce] = useState(0)

  const request = useCallback((command: string, onReady: (command: string) => void, name?: string) => {
    if (parseSnippetVariables(command).length === 0) {
      onReady(command)
      return
    }
    setNonce((value) => value + 1)
    setPending({ command, name, onReady })
  }, [])

  const dialog: ReactNode = pending ? (
    <SnippetVariableDialog
      key={nonce}
      command={pending.command}
      name={pending.name}
      onCancel={() => setPending(null)}
      onSubmit={(resolved) => {
        const { onReady } = pending
        setPending(null)
        onReady(resolved)
      }}
    />
  ) : null

  return { request, dialog }
}
