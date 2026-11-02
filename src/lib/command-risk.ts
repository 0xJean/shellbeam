/**
 * Conservative risk classification for shell commands suggested by the AI.
 * Read-only is an allowlist of tools and of the flags each tool may use: anything
 * unrecognised, substituted, expanded or redirected counts as changing state.
 * Destructive detection is a best-effort denylist, so it can never prove a
 * command safe; it only makes the commands it recognises wait for a click.
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
        if (quote === '"' && (ch === '`' || (ch === '$' && /[(A-Za-z_{]/.test(input[i + 1] ?? '')))) dynamic = true
        if (quote === '"' && ch === '\\' && i + 1 < input.length) { i += 1; word += input[i]; continue }
        word += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; hasWord = true; continue }
    if (ch === '\\' && i + 1 < input.length) { i += 1; if (input[i] !== '\n') { word += input[i]; hasWord = true } continue }
    if (ch === '#' && !hasWord) { while (i < input.length && input[i] !== '\n') i += 1; i -= 1; continue }
    if (ch === '`' || (ch === '$' && /[(A-Za-z_{'"]/.test(input[i + 1] ?? '')) || ((ch === '<' || ch === '>') && input[i + 1] === '(')) dynamic = true
    // Brace expansion and globs from the working directory can both produce flags.
    if (ch === '{' && /^[^\s]*(,|\.\.)/.test(input.slice(i + 1))) dynamic = true
    if (!hasWord && (ch === '*' || ch === '?' || (ch === '[' && !/^(\s|$)/.test(input.slice(i + 1))))) dynamic = true
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

/** Flags a tool may use and stay read-only. Anything else, including abbreviations, fails closed. */
interface FlagSpec {
  /** Short flags that take no value. */ short?: string
  /** Short flags that require a value, attached or as the next word. */ value?: string
  /** Long flags that take no separate value. */ long?: string
  /** Long flags that take a value, after `=` or as the next word. */ longValue?: string
  /** Numeric shorthand such as `head -20`. */ digits?: boolean
  /** Most positional words; a further one is often an output file. */ max?: number
}

function parseArgs(args: string[], spec: FlagSpec): string[] | null {
  const long = new Set((spec.long ?? '').split(' '))
  const longValue = new Set((spec.longValue ?? '').split(' '))
  const positionals: string[] = []
  let endOfFlags = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (endOfFlags || arg === '-' || !arg.startsWith('-')) { positionals.push(arg); continue }
    if (arg === '--') { endOfFlags = true; continue }
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]
      if (longValue.has(name)) { if (!arg.includes('=')) i += 1 } else if (!long.has(name)) return null
      continue
    }
    for (let j = 1; j < arg.length; j += 1) {
      const c = arg[j]
      if ((spec.digits && /\d/.test(c)) || spec.short?.includes(c)) continue
      if (!spec.value?.includes(c)) return null
      if (j === arg.length - 1) i += 1
      break
    }
  }
  return spec.max !== undefined && positionals.length > spec.max ? null : positionals
}

const passes = (args: string[], spec: FlagSpec) => parseArgs(args, spec) !== null
const verdict = (ok: boolean): CommandRisk => (ok ? 'read-only' : 'changes-state')

const LS: FlagSpec = { short: 'aAbBcCdfFgGhHiklLmnNopqQrRsStuUvwxXZ1', value: 'ITw', long: 'all almost-all color human-readable si inode numeric-uid-gid recursive reverse size classify directory group-directories-first full-time', longValue: 'sort time-style block-size' }
const GREP: FlagSpec = { short: 'EFGPivwxclLnHhqsrRaoIZzUbTyu', value: 'ABCefmdD', digits: true, long: 'ignore-case invert-match word-regexp line-regexp count files-with-matches files-without-match line-number with-filename no-filename quiet silent no-messages recursive dereference-recursive text only-matching extended-regexp fixed-strings basic-regexp perl-regexp color colour byte-offset null', longValue: 'after-context before-context context regexp file max-count include exclude exclude-dir include-dir exclude-from' }
const SUM: FlagSpec = { short: 'btz', long: 'binary text tag zero' }

/** Inspection tools with no sensible use of their other flags. Writers, executors and network tools are absent on purpose. */
const READ_ONLY: Record<string, FlagSpec> = {
  ls: LS, ll: LS, la: LS,
  cat: { short: 'AbeEnstTuv', long: 'number number-nonblank show-all show-ends show-tabs squeeze-blank' },
  tac: { short: 'br', value: 's' },
  head: { short: 'qvz', value: 'nc', digits: true, long: 'quiet silent verbose', longValue: 'lines bytes' },
  tail: { short: 'fFqvz', value: 'nc', digits: true, long: 'follow retry quiet silent verbose', longValue: 'lines bytes pid sleep-interval' },
  grep: GREP, egrep: GREP, fgrep: GREP, zgrep: GREP,
  rg: { short: 'iFSvwxclnNHIUuaL', value: 'ABCegtTmd', long: 'line-number no-line-number no-heading heading ignore-case smart-case case-sensitive hidden no-ignore files-with-matches count fixed-strings word-regexp color', longValue: 'glob type type-not max-count context before-context after-context max-depth' },
  zcat: { short: 'fqv' },
  du: { short: 'abcDhHklLmsSxPt', value: 'dBt', digits: false, long: 'all apparent-size bytes human-readable summarize total one-file-system inodes si', longValue: 'max-depth block-size threshold exclude time' },
  df: { short: 'ahHiklPTx', value: 'tx', long: 'all human-readable si inodes local print-type total portability', longValue: 'block-size type exclude-type' },
  free: { short: 'bkmghlLtvw', value: 'sc', long: 'human si total bytes kilo mega giga wide lohi', longValue: 'seconds count' },
  uptime: { short: 'ps', long: 'pretty since' },
  uname: { short: 'asnrvmpio', long: 'all', max: 0 },
  whoami: { max: 0 }, groups: {}, pwd: { short: 'LP', max: 0 },
  id: { short: 'gGnruzZ' },
  ps: { short: 'AaedfFHjlLNTwxyZ', value: 'opPuUCGgtkO', long: 'forest no-headers headers', longValue: 'sort format pid ppid user' },
  pstree: { short: 'aAcGhlnpstuUZ' },
  pgrep: { short: 'fxalnvci', value: 'uUgGPstd', long: 'full exact list-name list-full newest oldest count ignore-case', longValue: 'parent uid group' },
  top: { short: 'bcHiSs1', value: 'ndpouU' },
  htop: { max: 0 },
  w: { short: 'hsuf', max: 1 }, who: { short: 'aqbdHlmprstTuw' },
  last: { short: 'aFdiRwx', value: 'nspt' },
  lastlog: { value: 'tbu' },
  stat: { short: 'Lft', value: 'c', long: 'dereference file-system terse', longValue: 'format printf' },
  file: { short: 'bikLNz', long: 'brief mime mime-type mime-encoding dereference' },
  wc: { short: 'lwcmL', long: 'lines words bytes chars max-line-length' },
  uniq: { short: 'cdDiuz', value: 'fsw', long: 'count repeated unique ignore-case', longValue: 'skip-fields skip-chars check-chars', max: 1 },
  cut: { short: 'nsz', value: 'bcdf', long: 'complement only-delimited', longValue: 'bytes characters delimiter fields output-delimiter' },
  tr: { short: 'cCdst', long: 'complement delete squeeze-repeats truncate-set1', max: 2 },
  nl: { short: 'p', value: 'bdfhilnsvw' },
  column: { short: 'tnxeJ', value: 'sOoNcRHT', long: 'table', longValue: 'separator output-separator' },
  diff: { short: 'abBcdEiNqrsStTuwyZ', value: 'UCxXIFLW', digits: true, long: 'brief recursive unified side-by-side ignore-case ignore-all-space ignore-space-change ignore-blank-lines new-file report-identical-files color text', longValue: 'exclude width label', max: 2 },
  cmp: { short: 'blsz', value: 'inS', long: 'silent quiet verbose print-bytes' },
  comm: { short: '123z', long: 'check-order nocheck-order', max: 2 },
  which: { short: 'as' }, whereis: { short: 'bmsu' }, type: { short: 'aftpP' },
  printenv: { short: '0' },
  nproc: { long: 'all', longValue: 'ignore', max: 0 },
  lscpu: { short: 'aebcpyJx', long: 'all extended online offline parse json hex' },
  lsblk: { short: 'abdDfmnlpJSrtuOT', value: 'oxIe', long: 'all bytes nodeps fs perms noheadings list paths json scsi raw topology', longValue: 'output exclude include sort' },
  lsusb: { short: 'tvV', value: 'sdD' },
  lspci: { short: 'vknDmtqQ', value: 'sdi' },
  lsmod: { max: 0 },
  blkid: { short: 'lLU', value: 'ost' },
  vmstat: { short: 'adDfmnstw', value: 'S', long: 'active disk disk-sum forks slabs stats timestamp wide', longValue: 'unit' },
  iostat: { short: 'cdhkmNtxyz', value: 'pjg' },
  mpstat: { short: 'Au', value: 'IPN' },
  sar: { short: 'bBdFqrRSuvwWy', value: 'nIPse' },
  pidstat: { short: 'dlrstuUvwH', value: 'pCGT' },
  ss: { short: 'tulnpax46emirsOHw', long: 'tcp udp listening numeric processes all unix ipv4 ipv6 extended memory info resolve summary oneline no-header' },
  netstat: { short: 'tulnparisceWx46', long: 'tcp udp listening numeric programs all route interfaces statistics continuous extended wide unix' },
  lsof: { short: 'nPtlaRVwi46', value: 'pucgsFd' },
  md5sum: SUM, sha1sum: SUM, sha256sum: SUM, sha512sum: SUM,
  basename: { short: 'az', value: 's', long: 'multiple zero', longValue: 'suffix' },
  dirname: { short: 'z', long: 'zero' },
  realpath: { short: 'emsqLPz', long: 'canonicalize-existing canonicalize-missing no-symlinks quiet logical physical zero', longValue: 'relative-to relative-base' },
  readlink: { short: 'femnqsvz', long: 'canonicalize canonicalize-existing canonicalize-missing no-newline quiet silent verbose zero' },
  jq: { short: 'rceSsMjnCa', long: 'raw-output compact-output exit-status slurp sort-keys monochrome-output join-output null-input color-output ascii-output tab', longValue: 'indent' },
  cd: { short: 'LP', max: 1 },
  locale: { short: 'ack', long: 'all-locales charmaps category-name keyword-name' },
  getent: { short: 'i', long: 'no-idn' },
  tree: { short: 'adfFghiJlpqQrstuxCDnNX', value: 'LIP', long: 'noreport dirsfirst du si', longValue: 'filelimit charset sort' },
  hexdump: { short: 'bcCdovx', value: 'nse' },
  xxd: { short: 'abeEipu', value: 'clgos', max: 1 },
  od: { short: 'abcdfiloxsv', value: 'AjNStw' },
  strings: { short: 'afw', value: 'ntTe', digits: true },
  base64: { short: 'di', value: 'w', long: 'decode ignore-garbage', longValue: 'wrap' },
  ulimit: { short: 'acdefilmnpqrstuvx', max: 0 },
  sort: { short: 'bcCdfghiMnrRsuVz', value: 'kt', long: 'ignore-leading-blanks check dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting month-sort numeric-sort reverse random-sort stable unique version-sort zero-terminated', longValue: 'key field-separator' },
  date: { short: 'uR', value: 'd', long: 'utc rfc-email iso-8601', longValue: 'date rfc-3339' },
  hostname: { short: 'fisdAIy', long: 'fqdn ip-address short domain all-fqdns all-ip-addresses', max: 0 },
  dmesg: { short: 'TkuxtwLHePr', value: 'lf', long: 'ctime human kernel userspace decode notime follow nopager color', longValue: 'level facility since until time-format' },
  journalctl: { short: 'fbkrexqal', value: 'unpogSUtD', digits: true, long: 'follow dmesg reverse pager-end catalog quiet all full no-full no-pager utc system user list-boots disk-usage no-hostname', longValue: 'unit lines boot priority output grep since until identifier user-unit' },
}

/** Commands that are harmless with any arguments, because they never read them as options to act on. */
const ANY_ARGS = new Set(['echo', 'test', '[', 'true', 'false'])

const FIND_VALUE = new Set('name iname path ipath wholename iwholename regex iregex regextype type xtype user group uid gid perm size mtime mmin atime amin ctime cmin newer anewer cnewer maxdepth mindepth links inum samefile printf'.split(' '))
const FIND_BOOL = new Set('print print0 ls empty readable writable executable xdev mount depth daystart follow not o a or and prune nouser nogroup true false H L P'.split(' '))

function findIsReadOnly(args: string[]) {
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('-')) continue
    const name = args[i].slice(1)
    if (FIND_VALUE.has(name)) i += 1
    else if (!FIND_BOOL.has(name)) return false
  }
  return true
}

/** `sed -n 'Np'` and line ranges of it. Every other script could write or execute. */
function sedIsReadOnly(args: string[]) {
  const positionals = parseArgs(args, { short: 'n', max: 16 })
  if (!positionals || !args.includes('-n')) return false
  return /^(\d+|\$)(,(\d+|\$))?p$/.test(positionals[0] ?? '')
}

/** Only `awk '{print $1, $2}'`: awk reaches the shell, files and indirect calls in too many ways to denylist. */
function awkIsReadOnly(args: string[]) {
  const positionals = parseArgs(args, { value: 'F' })
  return !!positionals && /^\{\s*print(\s+\$\d+(\s*,\s*\$\d+)*)?\s*\}$/.test(positionals[0] ?? '')
}

const GIT_INSPECT: FlagSpec = { short: 'psbunzSGLl', value: '', digits: true, long: 'oneline graph stat shortstat numstat all decorate no-decorate abbrev-commit first-parent merges no-merges name-only name-status no-color color reverse follow patch cached staged porcelain short branch ignored untracked-files tags long always show-toplevel abbrev-ref git-dir is-inside-work-tree verify others modified deleted exclude-standard heads summary show-signature no-patch pretty format date', longValue: 'since until after before author committer grep max-count skip' }
const DOCKER_FLAGS: FlagSpec = { short: 'aqslntfv', long: 'all quiet size latest no-trunc timestamps follow no-stream details', longValue: 'format filter tail since until type last' }
const KUBE_FLAGS: FlagSpec = { short: 'AwfpN', value: 'nolc', long: 'all-namespaces watch follow previous show-labels no-headers timestamps minify', longValue: 'namespace output selector container tail since field-selector sort-by' }
const SYSTEMCTL_FLAGS: FlagSpec = { short: 'alq', value: 'tpn', long: 'no-pager all full failed plain no-legend user system value quiet', longValue: 'type state property lines output' }
const IP_FLAGS = new Set(['-br', '-brief', '-c', '-color', '-4', '-6', '-s', '-stats', '-d', '-details', '-o', '-oneline', '-j', '-json', '-p', '-pretty'])

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
  if (ANY_ARGS.has(prog)) return 'read-only'
  switch (prog) {
    case 'printf': return verdict(!args[0]?.startsWith('-')) // -v assigns a shell variable, such as PROMPT_COMMAND.
    case 'history': return verdict(args.length === 0 || (args.length === 1 && /^\d+$/.test(args[0])))
    case 'env': return args.length === 0 ? 'read-only' : 'changes-state'
    case 'date': { const words = parseArgs(args, READ_ONLY.date); return verdict(!!words && words.every((a) => a.startsWith('+'))) }
    case 'mount': return args.length === 0 ? 'read-only' : 'changes-state'
    case 'sed': return verdict(sedIsReadOnly(args))
    case 'awk': case 'gawk': case 'mawk': return verdict(awkIsReadOnly(args))
    case 'find':
      if (args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') && /(^|\/)(rm|shred|unlink)$/.test(args[i + 1] ?? ''))) return 'destructive'
      return verdict(findIsReadOnly(args))
    case 'crontab': return hasFlag(args, ['r']) ? 'destructive' : verdict(args.length === 1 && args[0] === '-l')
    case 'nginx': return args.length > 0 && args.every((a) => ['-t', '-T', '-v', '-V', '-q'].includes(a)) ? 'read-only' : 'changes-state'
    case 'apachectl': case 'apache2ctl': return args.length > 0 && args.every((a) => ['-t', '-S', '-v', '-V', '-M', 'configtest'].includes(a)) ? 'read-only' : 'changes-state'
    case 'sshd': return args.length > 0 && args.every((a) => ['-t', '-T'].includes(a)) ? 'read-only' : 'changes-state'
    case 'systemctl': {
      if (!sub) return verdict(passes(args, SYSTEMCTL_FLAGS))
      if (['stop', 'kill', 'mask', 'poweroff', 'reboot', 'halt', 'isolate', 'kexec'].includes(sub)) return 'destructive'
      return verdict(/^(status|show|cat|list-.+|is-active|is-enabled|is-failed|is-system-running|get-default|help)$/.test(sub) && passes(args, SYSTEMCTL_FLAGS))
    }
    case 'service': return rest[0] === 'stop' ? 'destructive' : verdict(args.length === 2 && rest[0] === 'status' || (args.length === 1 && args[0] === '--status-all'))
    case 'docker': case 'podman': { const risk = classifyDocker(positional(args)); return risk === 'read-only' ? verdict(passes(args, DOCKER_FLAGS)) : risk }
    case 'docker-compose': { const risk = classifyCompose(positional(args), args); return risk === 'read-only' ? verdict(passes(args, DOCKER_FLAGS)) : risk }
    case 'kubectl': {
      if (sub === 'delete' || sub === 'drain') return 'destructive'
      if (!passes(args, KUBE_FLAGS)) return 'changes-state'
      if (sub === 'config') return /^(view|get-contexts|current-context|get-clusters)$/.test(rest[0] ?? '') ? 'read-only' : 'changes-state'
      if (sub === 'auth') return rest[0] === 'can-i' ? 'read-only' : 'changes-state'
      return /^(get|describe|logs|top|version|explain|api-resources|api-versions|cluster-info)$/.test(sub ?? '') ? 'read-only' : 'changes-state'
    }
    case 'git': {
      if ((sub === 'reset' && args.includes('--hard')) || sub === 'clean' || (sub === 'push' && hasFlag(args, ['f'], ['--force', '--force-with-lease', '--delete', '--mirror'])) || (sub === 'branch' && hasFlag(args, ['D'])) || (sub === 'stash' && /^(drop|clear)$/.test(rest[0] ?? ''))) return 'destructive'
      // Global options such as -c can name a program to run, so the subcommand has to come first.
      const inner = args[0] === '--no-pager' ? args.slice(1) : args
      if (inner[0] !== sub) return 'changes-state'
      const subArgs = inner.slice(1)
      if (sub === 'reflog' && /^(expire|delete|drop)$/.test(rest[0] ?? '')) return 'changes-state'
      if (/^(status|log|diff|show|blame|shortlog|describe|rev-parse|ls-files|reflog)$/.test(sub ?? '')) return verdict(passes(subArgs, GIT_INSPECT))
      if (sub === 'remote' || sub === 'branch' || sub === 'tag') return rest.length === 0 && flags(args).every((a) => /^-(v|vv|a|r|l|-list|-all|-remotes|-verbose)$/.test(a)) ? 'read-only' : 'changes-state'
      if (sub === 'config') return verdict(subArgs.length > 0 && passes(subArgs, { short: 'l', long: 'list get get-all get-regexp show-origin', max: 2 }) && hasFlag(subArgs, ['l'], ['--get', '--get-all', '--list', '--get-regexp']))
      return 'changes-state'
    }
    case 'ip': {
      if (args.some((a) => /^(add|del|delete|set|flush|change|replace|append|prepend|save|restore|exec|up|down|monitor)$/.test(a))) return 'changes-state'
      if (flags(args).some((a) => !IP_FLAGS.has(a))) return 'changes-state' // -batch reads commands from a file.
      return verdict(/^(a|addr|address|r|ro|route|l|link|n|neigh|neighbour|rule|maddr)$/.test(sub ?? ''))
    }
    case 'iptables': case 'ip6tables':
      if (hasFlag(args, ['F', 'X', 'Z'], ['--flush', '--delete-chain', '--zero'])) return 'destructive'
      return verdict(hasFlag(args, ['L', 'S'], ['--list', '--list-rules']) && passes(args, { short: 'LSnvx', value: 't', long: 'list list-rules numeric verbose exact line-numbers', longValue: 'table' })) // --modprobe runs a program.
    case 'nft': return sub === 'flush' || sub === 'delete' ? 'destructive' : verdict(sub === 'list' && passes(args, { short: 'ansjt', long: 'handle numeric stateless json terse' }))
    case 'timedatectl': case 'hostnamectl': case 'localectl': return verdict((!sub || /^(status|show|list-.+)$/.test(sub)) && passes(args, { short: 'a', long: 'no-pager all' }))
    case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'zypper':
      if (/^(remove|purge|autoremove|erase)$/.test(sub ?? '')) return 'destructive'
      // Search, check-update and history subcommands reach the network or can roll back.
      return verdict(/^(list|show|policy|info|repolist)$/.test(sub ?? '') && passes(args, { short: 'aqC', long: 'installed upgradable upgrades available all-versions all' }))
    case 'apt-cache': return verdict(/^(search|show|showpkg|policy|depends|rdepends|madison)$/.test(sub ?? '') && passes(args, { short: 'nq', long: 'names-only full installed' }))
    case 'dpkg': return verdict(/^(-l|-L|-s|-S|-p|--list|--listfiles|--status|--search|--print-avail|--get-selections)$/.test(args[0] ?? '') && !args.slice(1).some((a) => a.startsWith('-')))
    case 'rpm': return verdict(/^-q[ailfcd]*$/.test(args[0] ?? '') && !args.slice(1).some((a) => a.startsWith('-'))) // --eval and macros can execute.
    default: {
      const spec = READ_ONLY[prog]
      return spec && Object.hasOwn(READ_ONLY, prog) ? verdict(passes(args, spec)) : 'changes-state'
    }
  }
}

function classifyDocker(pos: string[]): CommandRisk {
  const [sub, next] = pos
  if (pos.includes('prune') || sub === 'rm' || sub === 'rmi' || sub === 'kill' || (['container', 'image', 'volume', 'network'].includes(sub) && (next === 'rm' || next === 'kill'))) return 'destructive'
  if (sub === 'compose') return classifyCompose(pos.slice(1), pos.slice(1))
  if (/^(ps|images|logs|inspect|stats|version|info|top|port|diff|history|events)$/.test(sub ?? '')) return 'read-only'
  if (['container', 'image', 'volume', 'network', 'system', 'context', 'node', 'service'].includes(sub)) return /^(ls|ps|list|inspect|logs|top|port|stats|diff|history|df|info)$/.test(next ?? '') ? 'read-only' : 'changes-state'
  return 'changes-state'
}

function classifyCompose(pos: string[], args: string[]): CommandRisk {
  const sub = pos[0]
  if (sub === 'down' || sub === 'rm' || sub === 'kill') return 'destructive'
  if (args.some((a) => a === '-v' || a === '--volumes') && sub !== 'logs') return 'destructive'
  return /^(ps|logs|config|images|top|ls|version|port)$/.test(sub ?? '') ? 'read-only' : 'changes-state'
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Wrapper flags that cannot redirect output, change identity sources or run anything extra. */
const SAFE_WRAPPER_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-n', '-u', '-H', '--']),
  doas: new Set(['-u', '-n', '--']),
  time: new Set(['--']),
  nice: new Set(['-n', '--']),
  ionice: new Set(['-c', '-n', '--']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after', '--']),
}
const TRUSTED_PROGRAM_PATH = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$/

function classifySegment(words: string[]): CommandRisk {
  let i = 0
  // Any assignment can steer a tool into running something (LESSOPEN, GIT_PAGER, LD_PRELOAD).
  let uncertain = false
  const skipAssignments = () => { while (i < words.length && ASSIGNMENT.test(words[i])) { i += 1; uncertain = true } }
  skipAssignments()
  for (;;) {
    const name = words[i]
    if (name === undefined) return i === 0 ? 'read-only' : 'changes-state'
    if (name === 'env' && i + 1 < words.length) {
      // env's own options are not modelled; still look through it for a destructive program.
      uncertain = true
      i += 1
      while (i < words.length && words[i].startsWith('-')) i += 1
      skipAssignments()
      continue
    }
    const optsWithValue = WRAPPERS[name]
    if (!optsWithValue) break
    i += 1
    if (name === 'watch') {
      // watch hands its words to a shell, so a word can hold a whole command.
      while (i < words.length && words[i].startsWith('-')) { if (optsWithValue.has(words[i])) i += 1; i += 1 }
      return classifyCommandRisk(words.slice(i).join(' ')) === 'destructive' ? 'destructive' : 'changes-state'
    }
    if (name === 'timeout' && words[i] && !words[i].startsWith('-')) { i += 1; continue }
    if ((name === 'sudo' || name === 'doas') && words.slice(i).some((w) => w === '-s' || w === '-i' || w === '-e' || w === '--shell' || w === '--login' || w === '--edit')) return 'changes-state'
    while (i < words.length && words[i].startsWith('-')) {
      if (!SAFE_WRAPPER_FLAGS[name]?.has(words[i])) uncertain = true
      if (words[i] === '--') { i += 1; break }
      if (optsWithValue.has(words[i])) i += 1
      i += 1
    }
    skipAssignments()
    if (i >= words.length) return name === 'time' && !uncertain ? 'read-only' : 'changes-state'
  }
  const program = words[i]
  // A path can name any binary, whatever it is called; only system directories keep the tool's meaning.
  if (program.includes('/') && !TRUSTED_PROGRAM_PATH.test(program)) uncertain = true
  const risk = classifyProgram(program.split('/').pop() ?? program, words.slice(i + 1))
  return risk === 'read-only' && uncertain ? 'changes-state' : risk
}

/**
 * Control characters mean the shell may not see what this parser sees: a PTY line
 * discipline treats CR as Enter and Ctrl-U or DEL as editing, so `echo a\rrm -rf x`
 * and `rx\x7fm -rf x` both hide their real command. LF and tab are ordinary shell
 * syntax and are handled by the tokenizer.
 */
function hasControlCharacter(text: string) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 9 || code === 10) continue
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

export function classifyCommandRisk(command: string): CommandRisk {
  // Checked before trim(), which would remove a trailing CR. Highest risk, so that
  // automatic mode waits too: nothing after a control character can be trusted.
  if (hasControlCharacter(command)) return 'destructive'
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
        // Bash opens these itself, so this is a network connection rather than a file read.
        if (isInput) { if (/^\/dev\/(tcp|udp)\//.test(target.value)) raise('changes-state'); continue }
        if (token.value.endsWith('&') ? !/^\d+$|^-$/.test(target.value) : !SAFE_REDIRECT_TARGET.test(target.value)) raise(/^\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk)/.test(target.value) ? 'destructive' : 'changes-state')
      } else if (!isInput) raise('changes-state')
      continue
    }
    words.push(token.value)
  }
  finish()
  return risk
}
