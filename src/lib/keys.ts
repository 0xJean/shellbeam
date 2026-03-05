import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface GenerateSshKeyResult {
  privateKey: string
  publicKey: string
}

export async function generateSshKey(comment?: string | null): Promise<GenerateSshKeyResult> {
  try {
    return await invoke<GenerateSshKeyResult>('generate_ssh_key', { comment: comment ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function importPrivateKeyFromFile(): Promise<string> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: 'SSH Private Key', extensions: ['pem'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (!path || typeof path !== 'string') {
    throw new Error('Open cancelled')
  }
  try {
    return await invoke<string>('import_private_key_from_file', { payload: { path } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
