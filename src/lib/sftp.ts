import { invoke } from '@tauri-apps/api/core'

import type { AuthType } from '@/lib/ssh'

export interface SftpRequest {
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  remotePath: string
  transferId?: string
}

export interface SftpUploadRequest extends SftpRequest {
  contentB64: string
}

export interface SftpRenameRequest extends Omit<SftpRequest, 'remotePath'> {
  oldRemotePath: string
  newRemotePath: string
}

export interface SftpEntry {
  path: string
  fileName: string
  isDir: boolean
  size?: number
  modifiedAt?: number
}

export interface SftpFileData {
  path: string
  contentB64: string
  sizeBytes: number
}

export interface SftpTransferProgressEvent {
  transferId: string
  phase: string
  bytesProcessed: number
  bytesTotal?: number
  message: string
}

export interface SftpStandardError {
  code: string
  source: string
  retryable: boolean
  message: string
  detail?: string
  raw: string
}

function inferFallbackCode(raw: string) {
  const lowered = raw.toLowerCase()
  if (lowered.includes('auth')) return 'auth_failed'
  if (lowered.includes('permission denied') || lowered.includes('denied')) return 'permission_denied'
  if (lowered.includes('no such file') || lowered.includes('not found')) return 'not_found'
  if (lowered.includes('timeout') || lowered.includes('timed out')) return 'timeout'
  if (lowered.includes('tcp') || lowered.includes('handshake') || lowered.includes('network') || lowered.includes('connection')) {
    return 'network_error'
  }
  if (lowered.includes('required') || lowered.includes('invalid')) return 'validation_error'
  return 'unknown_error'
}

function inferRetryable(code: string) {
  return code === 'network_error' || code === 'timeout' || code === 'unknown_error'
}

function extractJsonPayload(raw: string): Record<string, unknown> | null {
  const candidates = [raw.trim(), raw.replace(/^Error:\s*/, '').trim()]
  const match = raw.match(/\{[\s\S]*\}$/)
  if (match) candidates.push(match[0].trim())
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // ignore and try next candidate
    }
  }
  return null
}

export function normalizeSftpError(error: unknown): SftpStandardError {
  const raw = String(error)
  const payload = extractJsonPayload(raw)
  if (payload) {
    const code = typeof payload.code === 'string' ? payload.code : inferFallbackCode(raw)
    const source = typeof payload.source === 'string' ? payload.source : 'unknown'
    const message = typeof payload.message === 'string' ? payload.message : 'SFTP operation failed'
    const detail = typeof payload.detail === 'string' ? payload.detail : undefined
    const retryable = typeof payload.retryable === 'boolean' ? payload.retryable : inferRetryable(code)
    return { code, source, retryable, message, detail, raw }
  }
  const code = inferFallbackCode(raw)
  return {
    code,
    source: 'unknown',
    retryable: inferRetryable(code),
    message: 'SFTP operation failed',
    detail: raw,
    raw,
  }
}

export async function sftpListDir(payload: SftpRequest) {
  return invoke<SftpEntry[]>('sftp_list_dir', { payload })
}

export async function sftpDownloadFile(payload: SftpRequest) {
  return invoke<SftpFileData>('sftp_download_file', { payload })
}

export async function sftpUploadFile(payload: SftpUploadRequest) {
  return invoke<void>('sftp_upload_file', { payload })
}

export async function sftpDeletePath(payload: SftpRequest) {
  return invoke<void>('sftp_delete_path', { payload })
}

export async function sftpRenamePath(payload: SftpRenameRequest) {
  return invoke<void>('sftp_rename_path', { payload })
}

export async function sftpCreateDir(payload: SftpRequest) {
  return invoke<void>('sftp_create_dir', { payload })
}

export async function sftpCreateFile(payload: SftpRequest) {
  return invoke<void>('sftp_create_file', { payload })
}

export async function sftpWriteFile(payload: SftpUploadRequest) {
  return invoke<void>('sftp_write_file', { payload })
}

export async function sftpHomeDir(payload: SftpRequest) {
  return invoke<string>('sftp_home_dir', { payload })
}

export interface SftpChmodRequest {
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  remotePath: string
  mode: number
}

export async function sftpChmod(payload: SftpChmodRequest) {
  return invoke<void>('sftp_chmod', { payload })
}

// --- Local filesystem ---

export interface LocalEntry {
  path: string
  fileName: string
  isDir: boolean
  size?: number
  modifiedAt?: number
}

export async function localListDir(dirPath: string) {
  return invoke<LocalEntry[]>('local_list_dir', { payload: { dirPath } })
}

export async function localHomeDir() {
  return invoke<string>('local_home_dir')
}

export async function localReadFileB64(path: string) {
  return invoke<string>('local_read_file_b64', { path })
}

export async function localWriteFileB64(path: string, contentB64: string) {
  return invoke<void>('local_write_file_b64', { path, contentB64 })
}
