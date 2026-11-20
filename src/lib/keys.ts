import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface GenerateSshKeyResult {
  privateKey: string
  publicKey: string
}

export interface PickedSshPrivateKey {
  content: string
  fileName: string
}

const PUBLIC_KEY_PREFIXES = [
  'ssh-rsa ',
  'ssh-ed25519 ',
  'ssh-dss ',
  'ecdsa-sha2-nistp256 ',
  'ecdsa-sha2-nistp384 ',
  'ecdsa-sha2-nistp521 ',
  'sk-ssh-ed25519@openssh.com ',
  'sk-ecdsa-sha2-nistp256@openssh.com ',
]

/** Detect whether the user accidentally pasted an OpenSSH public key (.pub) instead of a private key. */
export function isSshPublicKeyText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('PRIVATE KEY')) return false
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return PUBLIC_KEY_PREFIXES.some((prefix) => firstLine.startsWith(prefix))
}

export async function generateSshKey(comment?: string | null): Promise<GenerateSshKeyResult> {
  try {
    return await invoke<GenerateSshKeyResult>('generate_ssh_key', { comment: comment ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

/** Pick an SSH private key file, defaulting to the OS SSH directory (~/.ssh on macOS/Linux,
 * %USERPROFILE%\.ssh on Windows) with hidden files visible on macOS and no extension lockout. */
export async function pickPrivateKeyFile(): Promise<PickedSshPrivateKey | null> {
  try {
    return await invoke<PickedSshPrivateKey | null>('pick_ssh_private_key_file')
  } catch (error) {
    const message = toInvokeErrorMessage(error)
    // Fall back to the plugin dialog only when the native command is unavailable (e.g. mocks/tests).
    if (!/unknown command|not found/i.test(message)) {
      throw new Error(message)
    }
  }

  let defaultPath: string | undefined
  try {
    defaultPath = (await invoke<string | null>('default_ssh_dir')) ?? undefined
  } catch { /* ignore */ }

  const path = await open({
    multiple: false,
    directory: false,
    ...(defaultPath ? { defaultPath } : {}),
  })
  if (!path || typeof path !== 'string') {
    return null
  }
  try {
    const content = await invoke<string>('import_private_key_from_file', { payload: { path } })
    const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'ssh-key'
    return { content, fileName }
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function importPrivateKeyFromFile(): Promise<string> {
  const picked = await pickPrivateKeyFile()
  if (!picked) {
    throw new Error('Open cancelled')
  }
  return picked.content
}
