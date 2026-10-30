const PUBLIC_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
])

export interface OpenSshPublicKey {
  type: string
  blob: string
  comment: string
  /** Canonical single line: type, blob and optional comment. */
  line: string
  algorithm: string
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function readField(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } | null {
  if (offset + 4 > bytes.length) return null
  const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  const start = offset + 4
  if (start + length > bytes.length) return null
  return { value: bytes.subarray(start, start + length), next: start + length }
}

function rsaBits(bytes: Uint8Array): number | null {
  const type = readField(bytes, 0)
  const exponent = type && readField(bytes, type.next)
  const modulus = exponent && readField(bytes, exponent.next)
  if (!modulus) return null
  let n = modulus.value
  while (n.length && n[0] === 0) n = n.subarray(1)
  if (!n.length) return null
  return (n.length - 1) * 8 + Math.floor(Math.log2(n[0])) + 1
}

function algorithmLabel(type: string, bytes: Uint8Array): string {
  if (type === 'ssh-ed25519') return 'ED25519'
  if (type === 'sk-ssh-ed25519@openssh.com') return 'ED25519-SK'
  if (type === 'sk-ecdsa-sha2-nistp256@openssh.com') return 'ECDSA-SK'
  if (type === 'ssh-dss') return 'DSA'
  if (type.startsWith('ecdsa-sha2-nistp')) return `ECDSA ${type.slice('ecdsa-sha2-nistp'.length)}`
  const bits = rsaBits(bytes)
  return bits ? `RSA ${bits}` : 'RSA'
}

/** Accepts only a single OpenSSH public key line; anything else (including private key material) yields null. */
export function parseOpenSshPublicKey(value: string): OpenSshPublicKey | null {
  const text = value.trim()
  if (!text || /[\r\n]/.test(text) || /PRIVATE KEY/i.test(text)) return null
  if (Array.from(text).some((character) => { const code = character.charCodeAt(0); return (code < 32 && code !== 9) || code === 127 })) return null
  const [type, blob, ...rest] = text.split(/\s+/)
  if (!type || !blob || !PUBLIC_KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null
  const bytes = decodeBase64(blob)
  const embedded = bytes && readField(bytes, 0)
  if (!bytes || !embedded || new TextDecoder().decode(embedded.value) !== type) return null
  const comment = rest.join(' ')
  return { type, blob, comment, line: comment ? `${type} ${blob} ${comment}` : `${type} ${blob}`, algorithm: algorithmLabel(type, bytes) }
}

export async function openSshFingerprint(key: Pick<OpenSshPublicKey, 'blob'>): Promise<string | null> {
  const bytes = decodeBase64(key.blob)
  if (!bytes || !globalThis.crypto?.subtle) return null
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return `SHA256:${btoa(binary).replace(/=+$/, '')}`
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const AUTHORIZED_KEY_ADDED = 'shellbeam:authorized-key-added'
export const AUTHORIZED_KEY_PRESENT = 'shellbeam:authorized-key-present'

/**
 * POSIX shell command that appends the key to ~/.ssh/authorized_keys unless a line
 * already carries the same key blob. Existing file and directory modes are left untouched.
 */
export function buildAuthorizedKeysAppendCommand(key: OpenSshPublicKey): string {
  return [
    'set -e',
    'umask 077',
    `k=${shellQuote(key.line)}`,
    `b=${shellQuote(key.blob)}`,
    'f="$HOME/.ssh/authorized_keys"',
    '[ -d "$HOME/.ssh" ] || mkdir -m 700 "$HOME/.ssh"',
    '[ -f "$f" ] || { : > "$f"; chmod 600 "$f"; }',
    `if awk -v b="$b" '{ for (i = 1; i <= NF; i++) if ($i == b) found = 1 } END { exit !found }' "$f"; then echo ${AUTHORIZED_KEY_PRESENT}; else`,
    '  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf \'\\n\' >> "$f"; fi',
    `  printf '%s\\n' "$k" >> "$f"; echo ${AUTHORIZED_KEY_ADDED}`,
    'fi',
  ].join('\n')
}
