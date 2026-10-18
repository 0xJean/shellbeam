import type { HostProfile } from './hosts'
import { operationTransport } from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'

export const NETWORK_ROW_LIMIT = 200
export type NetworkSection = 'LISTEN' | 'CONNECTIONS' | 'INTERFACES' | 'ROUTES' | 'SUMMARY'
export type NetworkSectionStatus = 'ready' | 'unsupported' | 'unknown'
export interface NetworkSocket {
  protocol: 'tcp' | 'udp'
  state: string
  localAddress: string
  remoteAddress: string
  port: number | null
  pid: string | null
  process: string | null
}
export interface NetworkInterface { name: string; family: string; address: string }
export interface NetworkOpsSnapshot {
  status: 'ready' | 'partial' | 'unsupported' | 'unknown'
  sections: Record<NetworkSection, NetworkSectionStatus>
  listeners: NetworkSocket[]
  connections: NetworkSocket[]
  interfaces: NetworkInterface[]
  routes: string[]
  summary: string
  truncated: NetworkSection[]
  sampledAt: number
  transport: 'direct' | 'proxy-jump'
  errorCode?: string
}

// Commands and section names are fixed. awk consumes the producer to preserve its
// exit marker while bounding emitted lines/width without remote temporary files.
function section(name: NetworkSection, binary: string, args: string, limit = NETWORK_ROW_LIMIT) {
  return `printf '%s\\n' '__SB_NET_${name}_BEGIN'
if command -v ${binary} >/dev/null 2>&1; then
  { LC_ALL=C ${binary} ${args} 2>/dev/null; printf '\\n__SB_NET_${name}_STATUS=%s\\n' "$?"; } | awk 'NR<=${limit + 1} || /^__SB_NET_${name}_STATUS=/ { print substr($0,1,512) }'
else printf '%s\\n' '__SB_NET_${name}_STATUS=127'; fi
printf '%s\\n' '__SB_NET_${name}_END'`
}
export const NETWORK_OPS_COMMAND = [
  "printf '%s\\n' '__SB_NET_SCHEMA=1'",
  section('LISTEN', 'ss', '-H -lntup'),
  section('CONNECTIONS', 'ss', '-H -ntup'),
  section('INTERFACES', 'ip', '-o address show'),
  section('ROUTES', 'ip', '-o route show table main'),
  section('SUMMARY', 'ss', '-s', 32),
].join('\n')

function safeText(value: string, limit = 512) {
  return Array.from(value).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').trim().slice(0, limit)
}
export function safeNetworkPort(value: unknown): number | null {
  const text = String(value)
  if (!/^[0-9]{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}
export function networkPortCommand(port: number) {
  if (safeNetworkPort(port) === null) throw new Error('invalid_network_port')
  return `ss -lntup '( sport = :${port} )'`
}
export function networkProcessCommand(pid: string) {
  if (!/^[1-9][0-9]{0,8}$/.test(pid)) throw new Error('invalid_network_pid')
  return `ps -p ${pid} -o pid,ppid,user,etime,rss,vsz,pcpu,pmem,stat,comm`
}
function parseSocket(line: string): NetworkSocket | null {
  const [protocol, state, recv, send, localAddress, remoteAddress] = line.trim().split(/\s+/)
  if (!/^(tcp|udp)(6)?$/.test(protocol ?? '') || !/^\d+$/.test(recv ?? '') || !/^\d+$/.test(send ?? '') || !localAddress || !remoteAddress) return null
  const pid = line.match(/\bpid=([1-9][0-9]{0,8})(?=[,)])/u)?.[1] ?? null
  const process = line.match(/users:\(\("([^"\r\n]{1,128})"/)?.[1] ?? null
  return {
    protocol: protocol.startsWith('tcp') ? 'tcp' : 'udp', state: safeText(state, 32),
    localAddress: safeText(localAddress, 160), remoteAddress: safeText(remoteAddress, 160),
    port: safeNetworkPort(localAddress.slice(localAddress.lastIndexOf(':') + 1)), pid, process: process ? safeText(process, 128) : null,
  }
}
function emptySnapshot(now: number, transport: NetworkOpsSnapshot['transport']): NetworkOpsSnapshot {
  return { status: 'unknown', sections: { LISTEN: 'unknown', CONNECTIONS: 'unknown', INTERFACES: 'unknown', ROUTES: 'unknown', SUMMARY: 'unknown' }, listeners: [], connections: [], interfaces: [], routes: [], summary: '', truncated: [], sampledAt: now, transport }
}
export function parseNetworkOps(output: string, options: { now?: number; transport?: NetworkOpsSnapshot['transport'] } = {}): NetworkOpsSnapshot {
  const snapshot = emptySnapshot(options.now ?? Date.now(), options.transport ?? 'direct')
  if (!output.startsWith('__SB_NET_SCHEMA=1\n')) return snapshot
  const raw = {} as Record<NetworkSection, string[]>
  for (const name of Object.keys(snapshot.sections) as NetworkSection[]) {
    const begin = `__SB_NET_${name}_BEGIN\n`
    const end = `__SB_NET_${name}_END`
    const start = output.indexOf(begin)
    const finish = start < 0 ? -1 : output.indexOf(end, start + begin.length)
    raw[name] = []
    if (start < 0 || finish < 0) continue
    const lines = output.slice(start + begin.length, finish).split('\n')
    const status = lines.find((line) => line.startsWith(`__SB_NET_${name}_STATUS=`))?.split('=')[1]
    snapshot.sections[name] = status === '0' ? 'ready' : status === '127' ? 'unsupported' : 'unknown'
    if (snapshot.sections[name] !== 'ready') continue
    const data = lines.filter((line) => line.trim() && !line.startsWith(`__SB_NET_${name}_STATUS=`))
    const limit = name === 'SUMMARY' ? 32 : NETWORK_ROW_LIMIT
    if (data.length > limit) snapshot.truncated.push(name)
    raw[name] = data.slice(0, limit)
  }
  snapshot.listeners = raw.LISTEN.flatMap((line) => { const socket = parseSocket(line); return socket ? [socket] : [] })
  snapshot.connections = raw.CONNECTIONS.flatMap((line) => { const socket = parseSocket(line); return socket ? [socket] : [] })
  if ((raw.LISTEN.length && !snapshot.listeners.length) || (raw.CONNECTIONS.length && !snapshot.connections.length)) {
    if (raw.LISTEN.length && !snapshot.listeners.length) snapshot.sections.LISTEN = 'unknown'
    if (raw.CONNECTIONS.length && !snapshot.connections.length) snapshot.sections.CONNECTIONS = 'unknown'
  }
  snapshot.interfaces = raw.INTERFACES.flatMap((line) => {
    const match = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+(\S+)/)
    return match ? [{ name: safeText(match[1], 128), family: match[2], address: safeText(match[3], 160) }] : []
  })
  if (raw.INTERFACES.length && !snapshot.interfaces.length) snapshot.sections.INTERFACES = 'unknown'
  snapshot.routes = raw.ROUTES.map((line) => safeText(line))
  snapshot.summary = raw.SUMMARY.map((line) => safeText(line)).join('\n')
  const statuses = Object.values(snapshot.sections)
  snapshot.status = statuses.every((status) => status === 'unsupported') ? 'unsupported'
    : statuses.every((status) => status === 'ready') ? 'ready'
      : statuses.some((status) => status === 'ready') ? 'partial' : 'unknown'
  return snapshot
}

export async function collectNetworkOps(options: { host: HostProfile; vaultId?: string; resolveAuthSecret: (host: HostProfile) => Promise<string>; now?: number }): Promise<NetworkOpsSnapshot> {
  const transport = operationTransport(options.host)
  const now = options.now ?? Date.now()
  try {
    const result = await runWorkspaceRemoteCommand({ ...options, command: NETWORK_OPS_COMMAND, audit: { action: 'network.read', target: 'bounded host network snapshot' } })
    if (result.exitCode !== 0) return { ...emptySnapshot(now, transport), errorCode: result.errorCode ?? 'network_collection_failed' }
    return parseNetworkOps(result.stdout, { now, transport })
  } catch {
    return { ...emptySnapshot(now, transport), errorCode: 'network_state_unavailable' }
  }
}
