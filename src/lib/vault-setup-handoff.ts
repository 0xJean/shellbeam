import { useSyncExternalStore } from 'react'

type SetupSubmit = (password: string) => Promise<void>

/**
 * While the first-run welcome is on screen it creates the vault itself. The
 * vault gate holds back its initialize form and lends the welcome its own
 * submit handler, so creation still runs through the gate's data flow.
 */
let owners = 0
let submit: SetupSubmit | null = null
const listeners = new Set<() => void>()

function emit() { listeners.forEach((listener) => listener()) }
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function claimVaultSetup() {
  owners += 1
  emit()
  return () => { owners -= 1; emit() }
}

export function offerVaultSetup(handler: SetupSubmit) {
  submit = handler
  emit()
  return () => {
    if (submit !== handler) return
    submit = null
    emit()
  }
}

export function useWelcomeOwnsVaultSetup() {
  return useSyncExternalStore(subscribe, () => owners > 0)
}

export function useVaultSetupSubmit() {
  return useSyncExternalStore(subscribe, () => submit)
}
