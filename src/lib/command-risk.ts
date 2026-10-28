/**
 * Conservative risk classification for shell commands suggested by the AI.
 * Only commands built entirely from well-known inspection tools are read-only;
 * anything unrecognised, substituted or redirected counts as changing state.
 */
export type CommandRisk = 'read-only' | 'changes-state' | 'destructive'

const RANK: Record<CommandRisk, number> = { 'read-only': 0, 'changes-state': 1, destructive: 2 }

type Token = { kind: 'word'; value: string } | { kind: 'op'; value: string } | { kind: 'redirect'; value: string }

function tokenize(input: string): { tokens: Token[]; dynamic: boolean } {
  const tokens: Token[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  let dynamic = false
  const flush = () => { if (hasWord) tokens.push({ kind: 'word', value: word }); word = ''; hasWord = false }
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else {
        if (quote === '"' && (ch === '`' || (ch === '$' && input[i + 1] === '('))) dynamic = true
        if (quote === '"' && ch === '\\' && i + 1 < input.length) { i += 1; word += input[i]; continue }
        word += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; hasWord = true; continue }
    if (ch === '\\' && i + 1 < input.length) { i += 1; if (input[i] !== '\n') { word += input[i]; hasWord = true } continue }
    if (ch === '#' && !hasWord) { while (i < input.length && input[i] !== '\n') i += 1; i -= 1; continue }
    if (ch === '`' || (ch === '$' && input[i + 1] === '(') || ((ch === '<' || ch === '>') && input[i + 1] === '(')) dynamic = true
    if (ch === ' ' || ch === '\t') { flush(); continue }
    if (ch === '\n' || ch === ';') { flush(); tokens.push({ kind: 'op', value: ';' }); continue }
    if (ch === '&' && input[i + 1] === '>') {
      flush(); const append = input[i + 2] === '>'; i += append ? 2 : 1
      tokens.push({ kind: 'redirect', value: append ? '&>>' : '&>' }); continue
    }
    if (ch === '|' || ch === '&') {
      flush(); const double = input[i + 1] === ch; if (double) i += 1
      tokens.push({ kind: 'op', value: double ? ch + ch : ch }); continue
    }
    if (ch === '>' || ch === '<') {
      const fd = /^\d+$/.test(word) ? word : ''
      if (fd) { word = ''; hasWord = false } else flush()
      let op = ch
      if (input[i + 1] === ch) { op += ch; i += 1 }
      if (input[i + 1] === '&') { op += '&'; i += 1 }
      tokens.push({ kind: 'redirect', value: fd + op }); continue
    }
    word += ch
    hasWord = true
  }
  flush()
  if (quote) dynamic = true
  return { tokens, dynamic }
}

const READ_ONLY = new Set([
  'ls', 'll', 'la', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'zgrep', 'zcat', 'du', 'df',
  'free', 'uptime', 'uname', 'whoami', 'id', 'groups', 'pwd', 'ps', 'pstree', 'pgrep', 'top', 'htop', 'btop', 'atop', 'w', 'who',
  'last', 'lastlog', 'stat', 'file', 'wc', 'uniq', 'cut', 'tr', 'nl', 'column', 'diff', 'cmp', 'comm', 'which', 'whereis',
  'type', 'echo', 'printf', 'printenv', 'nproc', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'lsmod', 'blkid', 'vmstat', 'iostat',
  'mpstat', 'sar', 'pidstat', 'ss', 'netstat', 'lsof', 'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup',
  'host', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false',
  'test', '[', 'jq', 'cd', 'history', 'locale', 'getent', 'tree', 'hexdump', 'xxd', 'od', 'strings', 'base64', 'ulimit',
])

const DESTRUCTIVE = new Set([
  'rm', 'rmdir', 'shred', 'unlink', 'srm', 'dd', 'wipefs', 'mkswap', 'fdisk', 'sfdisk', 'gdisk', 'parted', 'shutdown', 'reboot',
  'poweroff', 'halt', 'init', 'telinit', 'kill', 'killall', 'pkill', 'userdel', 'groupdel', 'deluser', 'delgroup', 'truncate',
  'lvremove', 'vgremove', 'pvremove',
])

const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-T', '-D']),
  doas: new Set(['-u', '-C']),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  watch: new Set(['-n', '--interval', '-d']),
}

const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|index|user)|truncate\s+table|delete\s+from|flushall|flushdb)\b/i
const SAFE_REDIRECT_TARGET = /^(\/dev\/null|&?\d+|-)$/

function flags(args: string[]) { return args.filter((arg) => arg.startsWith('-')) }
function positional(args: string[]) { return args.filter((arg) => !arg.startsWith('-')) }
function hasFlag(args: string[], short: string[], long: string[] = []) {
  return args.some((arg) => long.some((l) => arg === l || arg.startsWith(`${l}=`)) || (/^-[^-]/.test(arg) && short.some((s) => arg.slice(1).includes(s))))
}

function classifyProgram(prog: string, args: string[]): CommandRisk {
  const sub = positional(args)[0]
  const rest = positional(args).slice(1)
  if (DESTRUCTIVE.has(prog) || prog.startsWith('mkfs')) return 'destructive'
  if (READ_ONLY.has(prog)) return 'read-only'
  switch (prog) {
    case 'env': return args.length === 0 ? 'read-only' : 'changes-state'
    case 'date': return hasFlag(args, ['s'], ['--set']) || positional(args).some((a) => !a.startsWith('+')) ? 'changes-state' : 'read-only'
    case 'hostname': return positional(args).length === 0 && !hasFlag(args, ['F', 'b'], ['--file', '--boot']) ? 'read-only' : 'changes-state'
    case 'dmesg': return hasFlag(args, ['c', 'C', 'D', 'E', 'n'], ['--clear', '--read-clear', '--console-off', '--console-on', '--console-level']) ? 'changes-state' : 'read-only'
    case 'mount': return args.length === 0 ? 'read-only' : 'changes-state'
    case 'sort': return hasFlag(args, ['o'], ['--output']) ? 'changes-state' : 'read-only'
    case 'journalctl': return args.some((a) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys)/.test(a)) ? 'changes-state' : 'read-only'
    case 'sed': return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) || args.some((a) => /(^|[;}/\s])[wWe](\s|$)/.test(a)) ? 'changes-state' : 'read-only'
    case 'awk': case 'gawk': case 'mawk': return args.some((a) => /system\s*\(|getline|>|\|/.test(a) || a === 'inplace') ? 'changes-state' : 'read-only'
    case 'find':
      if (args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') && /(^|\/)(rm|shred|unlink)$/.test(args[i + 1] ?? ''))) return 'destructive'
      return args.some((a) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)) ? 'changes-state' : 'read-only'
    case 'curl':
      return hasFlag(args, ['X', 'd', 'F', 'T', 'o', 'O', 'K', 'c'], ['--request', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '--form', '--upload-file', '--output', '--remote-name', '--config', '--cookie-jar']) ? 'changes-state' : 'read-only'
    case 'crontab': return hasFlag(args, ['r']) ? 'destructive' : hasFlag(args, ['l']) && positional(args).length === 0 ? 'read-only' : 'changes-state'
    case 'nginx': return args.length > 0 && args.every((a) => ['-t', '-T', '-v', '-V', '-q'].includes(a)) ? 'read-only' : 'changes-state'
    case 'apachectl': case 'apache2ctl': return args.length > 0 && args.every((a) => ['-t', '-S', '-v', '-V', '-M', 'configtest'].includes(a)) ? 'read-only' : 'changes-state'
    case 'sshd': return args.length > 0 && args.every((a) => ['-t', '-T'].includes(a)) ? 'read-only' : 'changes-state'
    case 'systemctl': {
      if (!sub) return 'read-only'
      if (['stop', 'kill', 'mask', 'poweroff', 'reboot', 'halt', 'isolate', 'kexec'].includes(sub)) return 'destructive'
      return /^(status|show|cat|list-.+|is-active|is-enabled|is-failed|is-system-running|get-default|help)$/.test(sub) ? 'read-only' : 'changes-state'
    }
    case 'service': return rest[0] === 'stop' ? 'destructive' : rest[0] === 'status' || hasFlag(args, [], ['--status-all']) ? 'read-only' : 'changes-state'
    case 'docker': case 'podman': return classifyDocker(positional(args))
    case 'docker-compose': return classifyCompose(positional(args), args)
    case 'kubectl': {
      if (sub === 'delete' || sub === 'drain') return 'destructive'
      if (sub === 'config') return /^(view|get-contexts|current-context|get-clusters)$/.test(rest[0] ?? '') ? 'read-only' : 'changes-state'
      if (sub === 'auth') return rest[0] === 'can-i' ? 'read-only' : 'changes-state'
      return /^(get|describe|logs|top|version|explain|api-resources|api-versions|cluster-info)$/.test(sub ?? '') ? 'read-only' : 'changes-state'
    }
    case 'git': {
      if ((sub === 'reset' && args.includes('--hard')) || sub === 'clean' || (sub === 'push' && hasFlag(args, ['f'], ['--force', '--force-with-lease', '--delete', '--mirror'])) || (sub === 'branch' && hasFlag(args, ['D'])) || (sub === 'stash' && /^(drop|clear)$/.test(rest[0] ?? ''))) return 'destructive'
      if (/^(status|log|diff|show|blame|shortlog|describe|rev-parse|ls-files|ls-remote|reflog)$/.test(sub ?? '')) return 'read-only'
      if (sub === 'remote' || sub === 'branch' || sub === 'tag') return rest.length === 0 && flags(args).every((a) => /^-(v|vv|a|r|l|-list|-all|-remotes|-verbose)$/.test(a)) ? 'read-only' : 'changes-state'
      if (sub === 'config') return hasFlag(args, ['l'], ['--get', '--get-all', '--list', '--get-regexp']) ? 'read-only' : 'changes-state'
      return 'changes-state'
    }
    case 'ip': {
      if (args.some((a) => /^(add|del|delete|set|flush|change|replace|append|prepend|save|restore|exec|up|down)$/.test(a))) return 'changes-state'
      return /^(a|addr|address|r|ro|route|l|link|n|neigh|neighbour|rule|maddr|-.*)$/.test(args[0] ?? '') ? 'read-only' : 'changes-state'
    }
    case 'iptables': case 'ip6tables': return hasFlag(args, ['F', 'X', 'Z'], ['--flush', '--delete-chain', '--zero']) ? 'destructive' : hasFlag(args, ['L', 'S'], ['--list', '--list-rules']) && !hasFlag(args, ['A', 'D', 'I', 'R', 'P', 'N', 'E'], ['--append', '--delete', '--insert', '--replace', '--policy', '--new-chain']) ? 'read-only' : 'changes-state'
    case 'nft': return sub === 'flush' || sub === 'delete' ? 'destructive' : sub === 'list' ? 'read-only' : 'changes-state'
    case 'timedatectl': case 'hostnamectl': case 'localectl': return !sub || /^(status|show|list-.+)$/.test(sub) ? 'read-only' : 'changes-state'
    case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'zypper':
      if (/^(remove|purge|autoremove|erase)$/.test(sub ?? '')) return 'destructive'
      return /^(list|show|search|policy|info|repolist|check-update|history)$/.test(sub ?? '') ? 'read-only' : 'changes-state'
    case 'apt-cache': return 'read-only'
    case 'dpkg': return /^(-l|-L|-s|-S|-p|--list|--listfiles|--status|--search|--print-avail|--get-selections)$/.test(args[0] ?? '') ? 'read-only' : 'changes-state'
    case 'rpm': return /^-q/.test(args[0] ?? '') ? 'read-only' : 'changes-state'
    default: return 'changes-state'
  }
}

function classifyDocker(pos: string[]): CommandRisk {
  const [sub, next] = pos
  if (pos.includes('prune') || sub === 'rm' || sub === 'rmi' || sub === 'kill' || (['container', 'image', 'volume', 'network'].includes(sub) && (next === 'rm' || next === 'kill'))) return 'destructive'
  if (sub === 'compose') return classifyCompose(pos.slice(1), pos.slice(1))
  if (/^(ps|images|logs|inspect|stats|version|info|top|port|diff|history|events|search)$/.test(sub ?? '')) return 'read-only'
  if (['container', 'image', 'volume', 'network', 'system', 'context', 'node', 'service'].includes(sub)) return /^(ls|ps|list|inspect|logs|top|port|stats|diff|history|df|info)$/.test(next ?? '') ? 'read-only' : 'changes-state'
  return 'changes-state'
}

function classifyCompose(pos: string[], args: string[]): CommandRisk {
  const sub = pos[0]
  if (sub === 'down' || sub === 'rm' || sub === 'kill') return 'destructive'
  if (args.some((a) => a === '-v' || a === '--volumes') && sub !== 'logs') return 'destructive'
  return /^(ps|logs|config|images|top|ls|version|port)$/.test(sub ?? '') ? 'read-only' : 'changes-state'
}

function classifySegment(words: string[]): CommandRisk {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
  for (;;) {
    const name = words[i]
    if (name === undefined) return i === 0 ? 'read-only' : 'changes-state'
    const optsWithValue = WRAPPERS[name]
    if (!optsWithValue) break
    i += 1
    if (name === 'timeout' && words[i] && !words[i].startsWith('-')) { i += 1; continue }
    if ((name === 'sudo' || name === 'doas') && words.slice(i).some((w) => w === '-s' || w === '-i' || w === '-e' || w === '--shell' || w === '--login' || w === '--edit')) return 'changes-state'
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '--') { i += 1; break }
      if (optsWithValue.has(words[i])) i += 1
      i += 1
    }
    if (i >= words.length) return name === 'time' ? 'read-only' : 'changes-state'
  }
  const prog = words[i].split('/').pop() ?? words[i]
  return classifyProgram(prog, words.slice(i + 1))
}

export function classifyCommandRisk(command: string): CommandRisk {
  const text = command.trim()
  if (!text) return 'changes-state'
  const { tokens, dynamic } = tokenize(text)
  let risk: CommandRisk = dynamic ? 'changes-state' : 'read-only'
  const raise = (next: CommandRisk) => { if (RANK[next] > RANK[risk]) risk = next }
  if (SQL_DESTRUCTIVE.test(text)) raise('destructive')
  let words: string[] = []
  const finish = () => { if (words.length) raise(classifySegment(words)); words = [] }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind === 'op') { finish(); continue }
    if (token.kind === 'redirect') {
      const target = tokens[i + 1]
      const isInput = token.value.includes('<')
      if (target?.kind === 'word') {
        i += 1
        if (isInput) continue
        if (token.value.endsWith('&') ? !/^\d+$|^-$/.test(target.value) : !SAFE_REDIRECT_TARGET.test(target.value)) raise(/^\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk)/.test(target.value) ? 'destructive' : 'changes-state')
      } else if (!isInput) raise('changes-state')
      continue
    }
    words.push(token.value)
  }
  finish()
  return risk
}
