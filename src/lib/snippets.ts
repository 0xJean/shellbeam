import { invoke } from '@tauri-apps/api/core'

import type { AuthType } from '@/lib/ssh'
import type { CommandRunResult } from '@/lib/sessions'

export interface SnippetEntry {
  id: string
  name: string
  command: string
  tags: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface SnippetDraft {
  name: string
  command: string
  tags?: string[]
}

export interface SnippetRunRequest {
  snippetId: string
  hostId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
}

export async function listSnippets(vaultId?: string | null) {
  return invoke<SnippetEntry[]>('list_snippets', { vaultId: vaultId ?? undefined })
}

export async function createSnippet(payload: SnippetDraft, vaultId?: string | null) {
  return invoke<SnippetEntry>('create_snippet', { payload, vaultId: vaultId ?? undefined })
}

export async function updateSnippet(payload: SnippetEntry, vaultId?: string | null) {
  return invoke<SnippetEntry>('update_snippet', { payload, vaultId: vaultId ?? undefined })
}

export async function deleteSnippet(id: string, vaultId?: string | null) {
  return invoke<void>('delete_snippet', { id, vaultId: vaultId ?? undefined })
}

export async function runSnippetCommand(payload: SnippetRunRequest, vaultId?: string | null) {
  return invoke<CommandRunResult>('run_snippet_command', { payload, vaultId: vaultId ?? undefined })
}
