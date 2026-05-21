import type { HostProfile } from '@/lib/hosts'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { invoke } from '@tauri-apps/api/core'

export interface WorkspaceInventoryResource {
  hostname: string
  os: string
  kernel: string
  uptime: string
  cpuPercent: number | null
  memoryPercent: number | null
  memoryText: string
  diskPercent: number | null
  diskText: string
  network: string
}

export interface WorkspaceInventoryTool {
  id: string
  name: string
  category: string
  binary: string
  path: string
  version: string
}

export interface WorkspaceInventoryService {
  name: string
  active: string
  enabled: string
}

export interface WorkspaceInventoryContainer {
  name: string
  image: string
  status: string
  ports: string
}

export interface WorkspaceInventoryPm2Process {
  raw: string
}

export interface WorkspaceInventoryProject {
  path: string
  kind: string
  name: string
  modifiedAt: string
}

export interface WorkspaceInventory {
  resource: WorkspaceInventoryResource
  tools: WorkspaceInventoryTool[]
  services: WorkspaceInventoryService[]
  containers: WorkspaceInventoryContainer[]
  pm2: WorkspaceInventoryPm2Process[]
  projects: WorkspaceInventoryProject[]
  scannedAt: number
}

export interface WorkspaceInventoryCacheEntry {
  inventory: WorkspaceInventory
  updatedAt: number
}

export type WorkspaceInventoryCache = Record<string, WorkspaceInventoryCacheEntry>

export interface WorkspaceInventorySnapshot {
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  inventory: WorkspaceInventory
  updatedAt: number
}

export interface WorkspaceInventoryHostStateSnapshot {
  hostKey: string
  hostId: string
  hostName: string
  hostAddress: string
  username: string
  port: number
  hostGroup: string
  tags: string[]
  authType: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  status: 'ready' | 'error'
  error?: string
  updatedAt: number
}

const WORKSPACE_INVENTORY_CACHE_KEY = 'shellbeam.workspaceInventoryCache.v1'
const memoryInventoryCache: WorkspaceInventoryCache = {}

const DEFAULT_RESOURCE: WorkspaceInventoryResource = {
  hostname: '',
  os: '',
  kernel: '',
  uptime: '',
  cpuPercent: null,
  memoryPercent: null,
  memoryText: '',
  diskPercent: null,
  diskText: '',
  network: '',
}

const INVENTORY_SCRIPT = `
sb_clean() {
  tr '\\n|' '  ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c 1-180
}

sb_emit() {
  printf '__SB_%s=%s\\n' "$1" "$2"
}

hostname_value="$(hostname 2>/dev/null | sb_clean)"
os_value="$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" | sb_clean)"
kernel_value="$(uname -sr 2>/dev/null | sb_clean)"
uptime_value="$(uptime -p 2>/dev/null | sed 's/^up //' | sb_clean)"

disk_line="$(df -hP / 2>/dev/null | awk 'NR==2 {used=$5; gsub(/%/,"",used); printf "%s|%s/%s", used, $3, $2}')"
disk_percent="$(printf '%s' "$disk_line" | awk -F'|' '{print $1}')"
disk_text="$(printf '%s' "$disk_line" | awk -F'|' '{print $2}')"

read cpu_user1 cpu_nice1 cpu_system1 cpu_idle1 cpu_iowait1 cpu_irq1 cpu_softirq1 cpu_steal1 <<EOF
$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)
EOF
read rx1 tx1 <<EOF
$(awk 'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx+0, tx+0}' /proc/net/dev 2>/dev/null)
EOF
sleep 1
read cpu_user2 cpu_nice2 cpu_system2 cpu_idle2 cpu_iowait2 cpu_irq2 cpu_softirq2 cpu_steal2 <<EOF
$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)
EOF
read rx2 tx2 <<EOF
$(awk 'NR>2 {gsub(/:/,"",$1); rx+=$2; tx+=$10} END {print rx+0, tx+0}' /proc/net/dev 2>/dev/null)
EOF
cpu_value="$(awk \
  -v u1="$cpu_user1" -v n1="$cpu_nice1" -v s1="$cpu_system1" -v i1="$cpu_idle1" -v w1="$cpu_iowait1" -v q1="$cpu_irq1" -v r1="$cpu_softirq1" -v t1="$cpu_steal1" \
  -v u2="$cpu_user2" -v n2="$cpu_nice2" -v s2="$cpu_system2" -v i2="$cpu_idle2" -v w2="$cpu_iowait2" -v q2="$cpu_irq2" -v r2="$cpu_softirq2" -v t2="$cpu_steal2" \
  'BEGIN {
    total1=u1+n1+s1+i1+w1+q1+r1+t1; idle1=i1+w1;
    total2=u2+n2+s2+i2+w2+q2+r2+t2; idle2=i2+w2;
    diff=total2-total1; idleDiff=idle2-idle1;
    if (diff > 0) {
      value=(diff-idleDiff) * 100 / diff;
      if (value < 0) value=0;
      if (value > 100) value=100;
      printf "%d", value + 0.5;
    }
  }')"
if [ -z "$cpu_value" ]; then
  cpu_value="$(LANG=C top -bn1 2>/dev/null | awk -F'id,' '/Cpu\\(s\\)|%Cpu/ {split($1,a,","); gsub(/[^0-9.]/,"",a[length(a)]); if (a[length(a)] != "") print int(100-a[length(a)])}' | head -n1)"
fi
if [ -z "$cpu_value" ]; then
  cpu_value="$(vmstat 1 2 2>/dev/null | tail -1 | awk '{print 100-$15}')"
fi

memory_line="$(awk '
  /^MemTotal:/ {total=$2}
  /^MemAvailable:/ {available=$2}
  /^MemFree:/ {free=$2}
  /^Buffers:/ {buffers=$2}
  /^Cached:/ {cached=$2}
  /^SReclaimable:/ {reclaim=$2}
  /^Shmem:/ {shmem=$2}
  END {
    if (total > 0) {
      if (available <= 0) available=free+buffers+cached+reclaim-shmem;
      used=total-available;
      if (used < 0) used=0;
      printf "%d|%dM/%dM", (used/total)*100, used/1024, total/1024;
    }
  }' /proc/meminfo 2>/dev/null)"
if [ -z "$memory_line" ]; then
  memory_line="$(free -m 2>/dev/null | awk '/Mem:/ {printf "%d|%sM/%sM", ($3/$2)*100, $3, $2}')"
fi
memory_percent="$(printf '%s' "$memory_line" | awk -F'|' '{print $1}')"
memory_text="$(printf '%s' "$memory_line" | awk -F'|' '{print $2}')"

network_value="$(awk -v rx1="$rx1" -v rx2="$rx2" -v tx1="$tx1" -v tx2="$tx2" 'BEGIN {printf "%.1f KB/s", ((rx2-rx1)+(tx2-tx1))/1024}')"

sb_emit HOSTNAME "$hostname_value"
sb_emit OS "$os_value"
sb_emit KERNEL "$kernel_value"
sb_emit UPTIME "$uptime_value"
sb_emit CPU "$cpu_value"
sb_emit MEMORY "$memory_percent|$memory_text"
sb_emit DISK "$disk_percent|$disk_text"
sb_emit NETWORK "$network_value"

sb_probe_tool() {
  tool_id="$1"
  tool_name="$2"
  category="$3"
  shift 3
  found=""
  for candidate in "$@"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      found="$candidate"
      break
    fi
  done
  if [ -z "$found" ]; then
    return 0
  fi
  path_value="$(command -v "$found" 2>/dev/null | sb_clean)"
  version_value="$("$found" --version 2>&1 | head -n 1 | sb_clean)"
  printf '__SB_TOOL=%s|%s|%s|%s|%s|%s\\n' "$tool_id" "$tool_name" "$category" "$found" "$path_value" "$version_value"
}

sb_probe_tool nginx Nginx web nginx
sb_probe_tool apache "Apache HTTPD" web apache2 httpd
sb_probe_tool caddy Caddy web caddy
sb_probe_tool haproxy HAProxy web haproxy
sb_probe_tool certbot Certbot web certbot
sb_probe_tool mysql MySQL database mysql mysqld
sb_probe_tool mariadb MariaDB database mariadb mysql
sb_probe_tool postgresql PostgreSQL database psql postgres
sb_probe_tool sqlite SQLite database sqlite3
sb_probe_tool mongodb MongoDB database mongod mongosh mongo
sb_probe_tool redis Redis cache redis-server redis-cli
sb_probe_tool memcached Memcached cache memcached
sb_probe_tool rabbitmq RabbitMQ queue rabbitmqctl
sb_probe_tool docker Docker containers docker
sb_probe_tool podman Podman containers podman
sb_probe_tool containerd containerd containers containerd
sb_probe_tool kubectl kubectl containers kubectl
sb_probe_tool helm Helm containers helm
sb_probe_tool k3s k3s containers k3s
sb_probe_tool node Node.js runtime node
sb_probe_tool npm npm package npm
sb_probe_tool pnpm pnpm package pnpm
sb_probe_tool yarn Yarn package yarn
sb_probe_tool bun Bun runtime bun
sb_probe_tool deno Deno runtime deno
sb_probe_tool python3 "Python 3" runtime python3
sb_probe_tool pip pip package pip3 pip
sb_probe_tool pipx pipx package pipx
sb_probe_tool go Go runtime go
sb_probe_tool rust Rust runtime rustc cargo
sb_probe_tool java Java runtime java
sb_probe_tool maven Maven build mvn
sb_probe_tool gradle Gradle build gradle
sb_probe_tool php PHP runtime php
sb_probe_tool php-fpm PHP-FPM runtime php-fpm php-fpm8.3 php-fpm8.2 php-fpm8.1
sb_probe_tool composer Composer package composer
sb_probe_tool ruby Ruby runtime ruby
sb_probe_tool git Git build git
sb_probe_tool curl curl build curl
sb_probe_tool wget wget build wget
sb_probe_tool jq jq build jq
sb_probe_tool yq yq build yq
sb_probe_tool make make build make
sb_probe_tool gcc GCC build gcc
sb_probe_tool cmake CMake build cmake
sb_probe_tool tmux tmux ops tmux
sb_probe_tool htop htop ops htop
sb_probe_tool rsync rsync ops rsync
sb_probe_tool ripgrep ripgrep ops rg
sb_probe_tool fd fd ops fd fdfind
sb_probe_tool ufw ufw security ufw
sb_probe_tool firewalld firewalld security firewall-cmd
sb_probe_tool fail2ban Fail2ban security fail2ban-client
sb_probe_tool openssl OpenSSL security openssl
sb_probe_tool nmap nmap security nmap
sb_probe_tool tcpdump tcpdump security tcpdump
sb_probe_tool wireguard WireGuard security wg
sb_probe_tool claude "Claude Code" agent claude
sb_probe_tool codex "Codex CLI" agent codex
sb_probe_tool gemini "Gemini CLI" agent gemini
sb_probe_tool aider Aider agent aider
sb_probe_tool ollama Ollama agent ollama
sb_probe_tool pm2 PM2 process pm2
sb_probe_tool supervisor Supervisor process supervisorctl
sb_probe_tool systemd systemd process systemctl

if command -v systemctl >/dev/null 2>&1; then
  for service in nginx apache2 httpd caddy haproxy mysql mariadb postgresql redis-server redis docker containerd k3s php-fpm php8.3-fpm php8.2-fpm php8.1-fpm supervisor cron crond ollama; do
    active_value="$(systemctl is-active "$service" 2>/dev/null || true)"
    enabled_value="$(systemctl is-enabled "$service" 2>/dev/null || true)"
    if [ "$active_value" != "unknown" ] || { [ -n "$enabled_value" ] && [ "$enabled_value" != "not-found" ]; }; then
      printf '__SB_SERVICE=%s|%s|%s\\n' "$service" "$active_value" "$enabled_value"
    fi
  done
fi

if command -v docker >/dev/null 2>&1; then
  docker ps --format '__SB_DOCKER={{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null | head -n 25
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 list --no-color 2>/dev/null | awk 'NR>3 && NR<24 {gsub(/[[:space:]]+/, " "); if (length($0) > 6) print "__SB_PM2=" substr($0, 1, 180)}'
fi

sb_project_kind() {
  case "$1" in
    package.json) printf 'node' ;;
    docker-compose.yml|compose.yml|compose.yaml|docker-compose.yaml) printf 'compose' ;;
    go.mod) printf 'go' ;;
    pyproject.toml|requirements.txt) printf 'python' ;;
    composer.json) printf 'php' ;;
    Cargo.toml) printf 'rust' ;;
    *) printf 'project' ;;
  esac
}

sb_project_name() {
  marker="$1"
  project_root="$2"
  marker_name="$(basename "$marker")"
  manifest_name=""
  case "$marker_name" in
    package.json)
      if command -v node >/dev/null 2>&1; then
        manifest_name="$(node -e 'try { const fs = require("fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name; if (typeof value === "string") process.stdout.write(value); } catch {}' "$marker" 2>/dev/null | sb_clean)"
      fi
      if [ -z "$manifest_name" ]; then
        manifest_name="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$marker" 2>/dev/null | head -n 1 | sb_clean)"
      fi
      ;;
    composer.json)
      manifest_name="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$marker" 2>/dev/null | head -n 1 | sb_clean)"
      ;;
    pyproject.toml)
      manifest_name="$(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$marker" 2>/dev/null | head -n 1 | sb_clean)"
      ;;
  esac
  if [ -n "$manifest_name" ]; then
    printf '%s' "$manifest_name"
  else
    basename "$project_root" | sb_clean
  fi
}

sb_project_root() {
  project_dir="$1"
  project_leaf="$(basename "$project_dir")"
  project_parent="$(dirname "$project_dir")"
  project_parent_leaf="$(basename "$project_parent")"

  case "$project_leaf" in
    current|live)
      dirname "$project_dir" | sb_clean
      return
      ;;
  esac

  if [ "$project_parent_leaf" = "releases" ] && [ "$project_parent" != "/" ]; then
    dirname "$project_parent" | sb_clean
    return
  fi

  printf '%s' "$project_dir" | sb_clean
}

for root in /var/www /srv /opt /home; do
  if [ -d "$root" ]; then
    find "$root" -maxdepth 4 -type f \\( -name package.json -o -name docker-compose.yml -o -name docker-compose.yaml -o -name compose.yml -o -name compose.yaml -o -name go.mod -o -name pyproject.toml -o -name requirements.txt -o -name composer.json -o -name Cargo.toml \\) 2>/dev/null | head -n 30
  fi
done | head -n 80 | while IFS= read -r marker; do
  project_dir="$(sb_project_root "$(dirname "$marker")")"
  marker_name="$(basename "$marker")"
  project_kind="$(sb_project_kind "$marker_name")"
  project_name="$(sb_project_name "$marker" "$project_dir")"
  modified_at="$(date -r "$marker" '+%Y-%m-%d %H:%M' 2>/dev/null || stat -c '%y' "$marker" 2>/dev/null | cut -d. -f1 | cut -c 1-16)"
  printf '__SB_PROJECT=%s|%s|%s|%s\\n' "$project_dir" "$project_kind" "$project_name" "$modified_at"
done
`.trim()

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const WORKSPACE_INVENTORY_COMMAND = `bash -lc ${shellQuote(INVENTORY_SCRIPT)}`

export function getWorkspaceInventoryHostKey(host: Pick<HostProfile, 'id' | 'address' | 'port' | 'username'>) {
  return host.id || `${host.username}@${host.address}:${host.port || 22}`
}

function isWorkspaceInventory(value: unknown): value is WorkspaceInventory {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventory>
  return !!record.resource
    && Array.isArray(record.tools)
    && Array.isArray(record.services)
    && Array.isArray(record.containers)
    && Array.isArray(record.pm2)
    && Array.isArray(record.projects)
    && typeof record.scannedAt === 'number'
}

function readLocalInventoryCache(): WorkspaceInventoryCache {
  if (typeof localStorage === 'undefined') return {}

  try {
    const raw = localStorage.getItem(WORKSPACE_INVENTORY_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.entries(parsed as Record<string, unknown>).reduce<WorkspaceInventoryCache>((cache, [key, value]) => {
      if (!value || typeof value !== 'object') return cache
      const entry = value as Partial<WorkspaceInventoryCacheEntry>
      if (!isWorkspaceInventory(entry.inventory) || typeof entry.updatedAt !== 'number') return cache
      cache[key] = { inventory: normalizeWorkspaceInventory(entry.inventory), updatedAt: entry.updatedAt }
      return cache
    }, {})
  } catch {
    return {}
  }
}

function writeLocalInventoryCache(cache: WorkspaceInventoryCache) {
  if (typeof localStorage === 'undefined') return

  try {
    localStorage.setItem(WORKSPACE_INVENTORY_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Best effort cache; storage may be unavailable or full.
  }
}

async function invokeWorkspaceInventoryCommand<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args)
  } catch {
    return null
  }
}

function toWorkspaceInventorySnapshot(host: HostProfile, entry: WorkspaceInventoryCacheEntry): WorkspaceInventorySnapshot {
  return {
    hostKey: getWorkspaceInventoryHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    inventory: entry.inventory,
    updatedAt: entry.updatedAt,
  }
}

function isWorkspaceInventorySnapshot(value: unknown): value is WorkspaceInventorySnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventorySnapshot>
  return typeof record.hostKey === 'string'
    && typeof record.hostId === 'string'
    && typeof record.hostName === 'string'
    && typeof record.hostAddress === 'string'
    && typeof record.username === 'string'
    && typeof record.port === 'number'
    && isWorkspaceInventory(record.inventory)
    && typeof record.updatedAt === 'number'
}

function isWorkspaceInventoryHostStateSnapshot(value: unknown): value is WorkspaceInventoryHostStateSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkspaceInventoryHostStateSnapshot>
  return typeof record.hostKey === 'string'
    && typeof record.hostId === 'string'
    && typeof record.hostName === 'string'
    && typeof record.hostAddress === 'string'
    && typeof record.username === 'string'
    && typeof record.port === 'number'
    && typeof record.hostGroup === 'string'
    && Array.isArray(record.tags)
    && typeof record.authType === 'string'
    && (record.status === 'ready' || record.status === 'error')
    && typeof record.updatedAt === 'number'
}

function toWorkspaceInventoryHostStateSnapshot(
  host: HostProfile,
  status: WorkspaceInventoryHostStateSnapshot['status'],
  updatedAt: number,
  error?: string,
): WorkspaceInventoryHostStateSnapshot {
  return {
    hostKey: getWorkspaceInventoryHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    hostGroup: host.group || 'Custom',
    tags: host.tags ?? [],
    authType: host.authType,
    jumpHost: host.jumpHost,
    jumpPort: host.jumpPort,
    jumpUser: host.jumpUser,
    status,
    error,
    updatedAt,
  }
}

export function loadWorkspaceInventoryCache(hosts: HostProfile[]): WorkspaceInventoryCache {
  const localCache = readLocalInventoryCache()
  const validKeys = new Set(hosts.map(getWorkspaceInventoryHostKey))
  const nextCache: WorkspaceInventoryCache = {}

  hosts.forEach((host) => {
    const key = getWorkspaceInventoryHostKey(host)
    const entry = memoryInventoryCache[key] ?? localCache[key]
    if (entry) nextCache[key] = { inventory: normalizeWorkspaceInventory(entry.inventory), updatedAt: entry.updatedAt }
  })

  Object.keys(memoryInventoryCache).forEach((key) => {
    if (!validKeys.has(key)) delete memoryInventoryCache[key]
  })
  Object.assign(memoryInventoryCache, nextCache)

  return nextCache
}

export async function loadWorkspaceInventoryHostStateSnapshots(hosts: HostProfile[]) {
  const snapshots = await invokeWorkspaceInventoryCommand<unknown[]>('list_workspace_inventory_host_states')
  if (!snapshots) return {}

  const hostByKey = new Map(hosts.map((host) => [getWorkspaceInventoryHostKey(host), host]))
  return snapshots.reduce<Record<string, WorkspaceInventoryHostStateSnapshot>>((states, snapshot) => {
    if (!isWorkspaceInventoryHostStateSnapshot(snapshot)) return states
    if (!hostByKey.has(snapshot.hostKey)) return states
    states[snapshot.hostKey] = snapshot
    return states
  }, {})
}

export async function saveWorkspaceInventoryHostStateSnapshot(
  host: HostProfile,
  status: WorkspaceInventoryHostStateSnapshot['status'],
  updatedAt = Date.now(),
  error?: string,
) {
  const payload = toWorkspaceInventoryHostStateSnapshot(host, status, updatedAt, error)
  await invokeWorkspaceInventoryCommand<void>('upsert_workspace_inventory_host_state', { payload })
  return payload
}

export async function loadWorkspaceInventoryPersistedCache(hosts: HostProfile[]): Promise<WorkspaceInventoryCache> {
  const fallbackCache = loadWorkspaceInventoryCache(hosts)
  const snapshots = await invokeWorkspaceInventoryCommand<unknown[]>('list_workspace_inventory_snapshots')
  if (!snapshots) return fallbackCache

  const hostByKey = new Map(hosts.map((host) => [getWorkspaceInventoryHostKey(host), host]))
  const nativeCache = snapshots.reduce<WorkspaceInventoryCache>((cache, snapshot) => {
    if (!isWorkspaceInventorySnapshot(snapshot)) return cache
    if (!hostByKey.has(snapshot.hostKey)) return cache
    cache[snapshot.hostKey] = { inventory: normalizeWorkspaceInventory(snapshot.inventory), updatedAt: snapshot.updatedAt }
    return cache
  }, {})

  Object.assign(memoryInventoryCache, nativeCache)
  if (Object.keys(nativeCache).length > 0) {
    writeLocalInventoryCache({ ...readLocalInventoryCache(), ...nativeCache })
  }

  return { ...fallbackCache, ...nativeCache }
}

export async function saveWorkspaceInventoryCacheEntry(host: HostProfile, inventory: WorkspaceInventory) {
  const key = getWorkspaceInventoryHostKey(host)
  const entry = { inventory: normalizeWorkspaceInventory(inventory), updatedAt: Date.now() }
  memoryInventoryCache[key] = entry

  const localCache = readLocalInventoryCache()
  localCache[key] = entry
  writeLocalInventoryCache(localCache)

  await invokeWorkspaceInventoryCommand<void>('upsert_workspace_inventory_snapshot', {
    payload: toWorkspaceInventorySnapshot(host, entry),
  })

  return entry
}

export function clearWorkspaceInventoryMemoryCache() {
  Object.keys(memoryInventoryCache).forEach((key) => {
    delete memoryInventoryCache[key]
  })
}

export function clearWorkspaceInventoryCache() {
  clearWorkspaceInventoryMemoryCache()
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(WORKSPACE_INVENTORY_CACHE_KEY)
    } catch {
      // Best effort cache cleanup.
    }
  }
  void invokeWorkspaceInventoryCommand<void>('clear_workspace_inventory_snapshots')
}

function parseNumber(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function markerValue(line: string, marker: string) {
  return line.startsWith(`${marker}=`) ? line.slice(marker.length + 1).trim() : null
}

const DEPLOYMENT_POINTER_DIRS = new Set(['current', 'live'])
const DEPLOYMENT_RELEASE_DIRS = new Set(['releases'])
const PROJECT_KIND_ORDER = ['compose', 'node', 'python', 'go', 'php', 'rust', 'project']

function normalizeUnixPath(path: string) {
  const trimmed = path.trim().replace(/\/+/g, '/')
  if (!trimmed) return ''
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

function splitUnixPath(path: string) {
  return normalizeUnixPath(path).split('/').filter(Boolean)
}

function buildUnixPath(parts: string[], absolute: boolean) {
  if (parts.length === 0) return absolute ? '/' : ''
  return `${absolute ? '/' : ''}${parts.join('/')}`
}

function pathBasename(path: string) {
  return splitUnixPath(path).at(-1) ?? ''
}

function cleanProjectDisplayName(name: string) {
  return name.trim().replace(/\s+/g, ' ')
}

function normalizeProjectPath(path: string) {
  const normalized = normalizeUnixPath(path)
  if (!normalized) return ''

  const parts = splitUnixPath(normalized)
  const absolute = normalized.startsWith('/')
  const releaseIndex = parts.findIndex((part, index) => (
    DEPLOYMENT_RELEASE_DIRS.has(part)
    && index > 0
    && index < parts.length - 1
  ))
  if (releaseIndex > 0) {
    return buildUnixPath(parts.slice(0, releaseIndex), absolute)
  }

  const leaf = parts.at(-1)
  if (leaf && DEPLOYMENT_POINTER_DIRS.has(leaf) && parts.length > 1) {
    return buildUnixPath(parts.slice(0, -1), absolute)
  }

  return normalized
}

function deriveProjectName(normalizedPath: string, rawName: string, rawPath: string) {
  const cleaned = cleanProjectDisplayName(rawName)
  const normalizedRawPath = normalizeUnixPath(rawPath)
  const rawLeaf = pathBasename(normalizedRawPath)
  const normalizedChanged = normalizedRawPath !== '' && normalizedRawPath !== normalizedPath
  if (cleaned && (!normalizedChanged || cleaned !== rawLeaf)) return cleaned
  return pathBasename(normalizedPath) || cleaned || 'project'
}

function splitProjectKinds(kind: string) {
  return kind
    .split(/[·,]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function mergeProjectKinds(...kinds: string[]) {
  const unique = new Set(kinds.flatMap(splitProjectKinds))
  if (unique.size === 0) unique.add('project')
  return [...unique].sort((a, b) => {
    const aIndex = PROJECT_KIND_ORDER.indexOf(a)
    const bIndex = PROJECT_KIND_ORDER.indexOf(b)
    const aRank = aIndex === -1 ? PROJECT_KIND_ORDER.length : aIndex
    const bRank = bIndex === -1 ? PROJECT_KIND_ORDER.length : bIndex
    return aRank === bRank ? a.localeCompare(b) : aRank - bRank
  }).join(' · ')
}

function preferProjectName(existing: string, next: string, path: string) {
  const fallback = pathBasename(path)
  if (!existing) return next || fallback
  if (next && existing === fallback && next !== fallback) return next
  return existing
}

function latestModifiedAt(existing: string, next: string) {
  if (!existing) return next
  if (!next) return existing
  return next.localeCompare(existing) > 0 ? next : existing
}

function normalizeWorkspaceInventoryProjects(projects: WorkspaceInventoryProject[]) {
  const byPath = new Map<string, WorkspaceInventoryProject>()

  projects.forEach((project) => {
    const path = normalizeProjectPath(project.path)
    if (!path) return

    const name = deriveProjectName(path, project.name, project.path)
    const kind = mergeProjectKinds(project.kind || 'project')
    const existing = byPath.get(path)
    if (!existing) {
      byPath.set(path, {
        path,
        kind,
        name,
        modifiedAt: project.modifiedAt,
      })
      return
    }

    existing.kind = mergeProjectKinds(existing.kind, kind)
    existing.name = preferProjectName(existing.name, name, path)
    existing.modifiedAt = latestModifiedAt(existing.modifiedAt, project.modifiedAt)
  })

  return [...byPath.values()]
}

function normalizeWorkspaceInventory(inventory: WorkspaceInventory): WorkspaceInventory {
  return {
    ...inventory,
    projects: normalizeWorkspaceInventoryProjects(inventory.projects),
  }
}

export function parseWorkspaceInventory(output: string): WorkspaceInventory {
  const resource = { ...DEFAULT_RESOURCE }
  const tools: WorkspaceInventoryTool[] = []
  const services: WorkspaceInventoryService[] = []
  const containers: WorkspaceInventoryContainer[] = []
  const pm2: WorkspaceInventoryPm2Process[] = []
  const projects: WorkspaceInventoryProject[] = []

  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const hostname = markerValue(line, '__SB_HOSTNAME')
      if (hostname !== null) {
        resource.hostname = hostname
        return
      }

      const os = markerValue(line, '__SB_OS')
      if (os !== null) {
        resource.os = os
        return
      }

      const kernel = markerValue(line, '__SB_KERNEL')
      if (kernel !== null) {
        resource.kernel = kernel
        return
      }

      const uptime = markerValue(line, '__SB_UPTIME')
      if (uptime !== null) {
        resource.uptime = uptime
        return
      }

      const cpu = markerValue(line, '__SB_CPU')
      if (cpu !== null) {
        resource.cpuPercent = parseNumber(cpu)
        return
      }

      const memory = markerValue(line, '__SB_MEMORY')
      if (memory !== null) {
        const [percent = '', text = ''] = memory.split('|')
        resource.memoryPercent = parseNumber(percent)
        resource.memoryText = text
        return
      }

      const disk = markerValue(line, '__SB_DISK')
      if (disk !== null) {
        const [percent = '', text = ''] = disk.split('|')
        resource.diskPercent = parseNumber(percent)
        resource.diskText = text
        return
      }

      const network = markerValue(line, '__SB_NETWORK')
      if (network !== null) {
        resource.network = network
        return
      }

      const tool = markerValue(line, '__SB_TOOL')
      if (tool !== null) {
        const [id = '', name = '', category = '', binary = '', path = '', version = ''] = tool.split('|')
        if (id && name) tools.push({ id, name, category, binary, path, version })
        return
      }

      const service = markerValue(line, '__SB_SERVICE')
      if (service !== null) {
        const [name = '', active = '', enabled = ''] = service.split('|')
        if (name) services.push({ name, active, enabled })
        return
      }

      const docker = markerValue(line, '__SB_DOCKER')
      if (docker !== null) {
        const [name = '', image = '', status = '', ports = ''] = docker.split('|')
        if (name) containers.push({ name, image, status, ports })
        return
      }

      const pm2Line = markerValue(line, '__SB_PM2')
      if (pm2Line !== null) {
        if (pm2Line) pm2.push({ raw: pm2Line })
        return
      }

      const project = markerValue(line, '__SB_PROJECT')
      if (project !== null) {
        const [path = '', kind = '', name = '', modifiedAt = ''] = project.split('|')
        if (path) projects.push({ path, kind, name, modifiedAt })
      }
    })

  return normalizeWorkspaceInventory({
    resource,
    tools,
    services,
    containers,
    pm2,
    projects,
    scannedAt: Date.now(),
  })
}

function buildWorkspaceInventoryError(result: { stderr?: string; exitCode?: number; errorType?: string; errorCode?: string }) {
  const message = result.stderr?.trim()
    || result.errorCode
    || result.errorType
    || `inventory command failed with exit code ${result.exitCode ?? 'unknown'}`
  return new Error(message)
}

export async function fetchWorkspaceInventory(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  const { host, resolveAuthSecret } = options
  const result = await runWorkspaceRemoteCommand({
    host,
    resolveAuthSecret,
    command: WORKSPACE_INVENTORY_COMMAND,
  })
  if (result.exitCode !== 0) {
    throw buildWorkspaceInventoryError(result)
  }

  return parseWorkspaceInventory([result.stdout, result.stderr].filter(Boolean).join('\n'))
}
