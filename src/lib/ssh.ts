/** `agent`: keys held by the SSH agent on this computer; nothing is stored. Desktop only. */
export type AuthType = 'password' | 'privateKey' | 'agent'

/** iOS and Android have no SSH agent. */
export const sshAgentAvailable = () => typeof navigator === 'undefined' || !/iPhone|iPad|iPod|Android/.test(navigator.userAgent)
