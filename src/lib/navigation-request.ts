/**
 * Lets deep panels (e.g. a deployment's directory) ask the app shell to open a
 * terminal or SFTP for a host at a given directory without threading callbacks
 * through every workspace shell. The PC layout handles these requests.
 */
export const OPEN_TERMINAL_REQUEST_EVENT = 'shellbeam:open-terminal-request'
export const OPEN_SFTP_REQUEST_EVENT = 'shellbeam:open-sftp-request'

export interface HostDirectoryRequest { vaultId?: string; hostId: string; path: string }

export function requestHostTerminal(request: HostDirectoryRequest) {
  window.dispatchEvent(new CustomEvent<HostDirectoryRequest>(OPEN_TERMINAL_REQUEST_EVENT, { detail: request }))
}

let pendingSftp: HostDirectoryRequest | null = null

export function requestHostSftp(request: HostDirectoryRequest) {
  pendingSftp = request
  window.dispatchEvent(new CustomEvent<HostDirectoryRequest>(OPEN_SFTP_REQUEST_EVENT, { detail: request }))
}

/** The SFTP view takes the request once its host is selected. */
export function consumeSftpRequest(hostId: string | null | undefined): string | null {
  if (!pendingSftp || !hostId || pendingSftp.hostId !== hostId) return null
  const path = pendingSftp.path
  pendingSftp = null
  return path
}

/** POSIX single-quote quoting so a directory name can never be read as shell syntax. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Connection dialogs and overlays ask the app shell to open Known Hosts or close a session tab. */
export const OPEN_KNOWN_HOSTS_REQUEST_EVENT = 'shellbeam:open-known-hosts-request'
export const CLOSE_SESSION_REQUEST_EVENT = 'shellbeam:close-session-request'

export function requestKnownHosts() {
  window.dispatchEvent(new CustomEvent(OPEN_KNOWN_HOSTS_REQUEST_EVENT))
}

export function requestCloseSession(sessionId: string) {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(CLOSE_SESSION_REQUEST_EVENT, { detail: { sessionId } }))
}
