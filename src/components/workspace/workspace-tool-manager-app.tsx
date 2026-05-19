import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { cn } from '@/lib/utils'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import {
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
} from '@/lib/workspace-inventory'
import {
  createReadyWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  selectWorkspaceInventoryStatesForHosts,
  useWorkspaceInventoryStates,
} from '@/lib/workspace-inventory-state'
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Download,
  PackageOpen,
  PackagePlus,
  PackageSearch,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
  Shield,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspacePanelHeader } from './workspace-panel-header'
import { WorkspaceServerList } from './workspace-server-list'
import { Dialog, DialogContent } from '../ui/dialog'

const TOOL_CATEGORIES = [
  { id: 'web', label: 'Web / Proxy' },
  { id: 'database', label: 'Databases' },
  { id: 'cacheQueue', label: 'Cache / Queue' },
  { id: 'containers', label: 'Containers' },
  { id: 'runtime', label: 'Runtimes' },
  { id: 'packageManagers', label: 'Package Managers' },
  { id: 'buildOps', label: 'Build / Ops' },
  { id: 'securityNetwork', label: 'Security / Network' },
  { id: 'aiAgents', label: 'AI Agent CLI' },
  { id: 'processManagers', label: 'Process Managers' },
] as const

type ToolCategoryId = (typeof TOOL_CATEGORIES)[number]['id']
type LinuxPackageManager = 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk'
type PackageSpec = string[] | Partial<Record<LinuxPackageManager, string[]>>

interface PackageInstallRecipe {
  type: 'package'
  packages: PackageSpec
}

interface NpmInstallRecipe {
  type: 'npm'
  packageName: string
}

interface PipxInstallRecipe {
  type: 'pipx'
  packageName: string
}

type InstallRecipe = PackageInstallRecipe | NpmInstallRecipe | PipxInstallRecipe

export interface ToolDefinition {
  id: string
  name: string
  category: ToolCategoryId
  binary: string
  logoSlug?: string
  binaries?: string[]
  aliases?: string[]
  description: string
  install?: InstallRecipe
  service?: string
  versionCommand?: string
}

export type ToolAction =
  | 'check'
  | 'install'
  | 'upgrade'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'enable'
  | 'disable'
  | 'status'
  | 'logs'

export interface ToolStatus {
  installed: boolean | null
  path?: string
  version?: string
  serviceActive?: string
  serviceEnabled?: string
  checkedAt?: string
}

interface WorkspaceToolManagerAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenTerminal?: (host: HostProfile) => void
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

const DEFAULT_PACKAGE_SPEC = {
  apt: [''],
  dnf: [''],
  yum: [''],
  pacman: [''],
  zypper: [''],
  apk: [''],
} satisfies Record<LinuxPackageManager, string[]>

const SIMPLE_ICONS_BASE_URL = 'https://cdn.simpleicons.org'

const TOOL_LOGO_SLUGS: Partial<Record<string, string>> = {
  nginx: 'nginx',
  apache: 'apache',
  caddy: 'caddy',
  haproxy: 'haproxy',
  certbot: 'letsencrypt',
  traefik: 'traefikproxy',
  mysql: 'mysql',
  mariadb: 'mariadb',
  postgresql: 'postgresql',
  sqlite: 'sqlite',
  mongodb: 'mongodb',
  clickhouse: 'clickhouse',
  redis: 'redis',
  memcached: 'memcached',
  rabbitmq: 'rabbitmq',
  kafka: 'apachekafka',
  docker: 'docker',
  'docker-compose': 'docker',
  podman: 'podman',
  containerd: 'containerd',
  kubectl: 'kubernetes',
  helm: 'helm',
  k3s: 'k3s',
  node: 'nodedotjs',
  npm: 'npm',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun',
  deno: 'deno',
  python3: 'python',
  pip: 'pypi',
  pipx: 'python',
  go: 'go',
  rust: 'rust',
  java: 'openjdk',
  maven: 'apachemaven',
  gradle: 'gradle',
  php: 'php',
  'php-fpm': 'php',
  composer: 'composer',
  ruby: 'ruby',
  gem: 'rubygems',
  git: 'git',
  curl: 'curl',
  wget: 'gnu',
  jq: 'jq',
  yq: 'yaml',
  make: 'gnu',
  gcc: 'gnu',
  cmake: 'cmake',
  tmux: 'tmux',
  htop: 'linux',
  unzip: 'linux',
  rsync: 'linux',
  ripgrep: 'rust',
  fd: 'rust',
  ufw: 'ubuntu',
  firewalld: 'redhat',
  fail2ban: 'linux',
  openssl: 'openssl',
  nmap: 'nmap',
  tcpdump: 'linux',
  wireguard: 'wireguard',
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'googlegemini',
  aider: 'aider',
  ollama: 'ollama',
  'langchain-cli': 'langchain',
  pm2: 'pm2',
  supervisor: 'python',
  systemd: 'systemd',
}

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'web',
    binary: 'nginx',
    aliases: ['reverse proxy', 'web server'],
    description: 'HTTP server and reverse proxy.',
    service: 'nginx',
    versionCommand: '$found -v 2>&1 | head -n 1',
    install: { type: 'package', packages: ['nginx'] },
  },
  {
    id: 'apache',
    name: 'Apache HTTPD',
    category: 'web',
    binary: 'apache2',
    binaries: ['apache2', 'httpd'],
    aliases: ['httpd', 'apache2'],
    description: 'General purpose HTTP server.',
    service: 'apache2',
    install: {
      type: 'package',
      packages: { apt: ['apache2'], dnf: ['httpd'], yum: ['httpd'], pacman: ['apache'], zypper: ['apache2'], apk: ['apache2'] },
    },
  },
  { id: 'caddy', name: 'Caddy', category: 'web', binary: 'caddy', description: 'Automatic HTTPS web server.', service: 'caddy', install: { type: 'package', packages: ['caddy'] } },
  { id: 'haproxy', name: 'HAProxy', category: 'web', binary: 'haproxy', description: 'TCP and HTTP load balancer.', service: 'haproxy', install: { type: 'package', packages: ['haproxy'] } },
  { id: 'certbot', name: 'Certbot', category: 'web', binary: 'certbot', description: 'Let us encrypt certificate automation.', install: { type: 'package', packages: ['certbot'] } },
  { id: 'traefik', name: 'Traefik', category: 'web', binary: 'traefik', description: 'Cloud-native reverse proxy.', service: 'traefik', install: { type: 'package', packages: ['traefik'] } },

  { id: 'mysql', name: 'MySQL', category: 'database', binary: 'mysql', aliases: ['mysqld'], description: 'MySQL client and server tooling.', service: 'mysql', install: { type: 'package', packages: { apt: ['mysql-server'], dnf: ['mysql-server'], yum: ['mysql-server'], pacman: ['mysql'], zypper: ['mysql'], apk: ['mysql', 'mysql-client'] } } },
  { id: 'mariadb', name: 'MariaDB', category: 'database', binary: 'mariadb', binaries: ['mariadb', 'mysql'], description: 'MariaDB server and client tooling.', service: 'mariadb', install: { type: 'package', packages: { apt: ['mariadb-server'], dnf: ['mariadb-server'], yum: ['mariadb-server'], pacman: ['mariadb'], zypper: ['mariadb'], apk: ['mariadb', 'mariadb-client'] } } },
  { id: 'postgresql', name: 'PostgreSQL', category: 'database', binary: 'psql', aliases: ['pgsql', 'postgres'], description: 'PostgreSQL server and psql client.', service: 'postgresql', install: { type: 'package', packages: ['postgresql'] } },
  { id: 'sqlite', name: 'SQLite', category: 'database', binary: 'sqlite3', description: 'Embedded SQL database tools.', install: { type: 'package', packages: ['sqlite3'] } },
  { id: 'mongodb', name: 'MongoDB', category: 'database', binary: 'mongod', aliases: ['mongo', 'mongosh'], description: 'MongoDB daemon and shell.', service: 'mongod', install: { type: 'package', packages: { apt: ['mongodb'], dnf: ['mongodb'], yum: ['mongodb'], pacman: ['mongodb'], zypper: ['mongodb'], apk: ['mongodb'] } } },
  { id: 'clickhouse', name: 'ClickHouse', category: 'database', binary: 'clickhouse', description: 'Column-oriented OLAP database.', service: 'clickhouse-server', install: { type: 'package', packages: ['clickhouse-server', 'clickhouse-client'] } },

  { id: 'redis', name: 'Redis', category: 'cacheQueue', binary: 'redis-server', aliases: ['redis-cli'], description: 'In-memory data store and cache.', service: 'redis-server', install: { type: 'package', packages: { apt: ['redis-server'], dnf: ['redis'], yum: ['redis'], pacman: ['redis'], zypper: ['redis'], apk: ['redis'] } } },
  { id: 'memcached', name: 'Memcached', category: 'cacheQueue', binary: 'memcached', description: 'Distributed memory object cache.', service: 'memcached', install: { type: 'package', packages: ['memcached'] } },
  { id: 'rabbitmq', name: 'RabbitMQ', category: 'cacheQueue', binary: 'rabbitmqctl', description: 'Message broker and queue server.', service: 'rabbitmq-server', install: { type: 'package', packages: ['rabbitmq-server'] } },
  { id: 'kafka', name: 'Kafka', category: 'cacheQueue', binary: 'kafka-server-start', description: 'Distributed event streaming platform.', service: 'kafka', install: { type: 'package', packages: ['kafka'] } },

  { id: 'docker', name: 'Docker', category: 'containers', binary: 'docker', description: 'Container runtime and CLI.', service: 'docker', install: { type: 'package', packages: { apt: ['docker.io'], dnf: ['docker'], yum: ['docker'], pacman: ['docker'], zypper: ['docker'], apk: ['docker'] } } },
  { id: 'docker-compose', name: 'Docker Compose', category: 'containers', binary: 'docker', aliases: ['compose'], description: 'Docker multi-container project runner.', versionCommand: 'docker compose version 2>&1 | head -n 1', install: { type: 'package', packages: { apt: ['docker-compose-plugin'], dnf: ['docker-compose-plugin'], yum: ['docker-compose-plugin'], pacman: ['docker-compose'], zypper: ['docker-compose'], apk: ['docker-compose'] } } },
  { id: 'podman', name: 'Podman', category: 'containers', binary: 'podman', description: 'Daemonless container engine.', service: 'podman', install: { type: 'package', packages: ['podman'] } },
  { id: 'containerd', name: 'containerd', category: 'containers', binary: 'containerd', description: 'Container runtime daemon.', service: 'containerd', install: { type: 'package', packages: ['containerd'] } },
  { id: 'kubectl', name: 'kubectl', category: 'containers', binary: 'kubectl', aliases: ['kubernetes'], description: 'Kubernetes command line client.', install: { type: 'package', packages: ['kubectl'] } },
  { id: 'helm', name: 'Helm', category: 'containers', binary: 'helm', description: 'Kubernetes package manager.', install: { type: 'package', packages: ['helm'] } },
  { id: 'k3s', name: 'k3s', category: 'containers', binary: 'k3s', description: 'Lightweight Kubernetes distribution.', service: 'k3s' },

  { id: 'node', name: 'Node.js', category: 'runtime', binary: 'node', description: 'JavaScript runtime.', install: { type: 'package', packages: { apt: ['nodejs'], dnf: ['nodejs'], yum: ['nodejs'], pacman: ['nodejs'], zypper: ['nodejs'], apk: ['nodejs'] } } },
  { id: 'npm', name: 'npm', category: 'packageManagers', binary: 'npm', description: 'Node.js package manager.', install: { type: 'package', packages: ['npm'] } },
  { id: 'pnpm', name: 'pnpm', category: 'packageManagers', binary: 'pnpm', description: 'Fast Node.js package manager.', install: { type: 'npm', packageName: 'pnpm' } },
  { id: 'yarn', name: 'Yarn', category: 'packageManagers', binary: 'yarn', description: 'Node.js package manager.', install: { type: 'npm', packageName: 'yarn' } },
  { id: 'bun', name: 'Bun', category: 'runtime', binary: 'bun', description: 'JavaScript runtime and package manager.', install: { type: 'npm', packageName: 'bun' } },
  { id: 'deno', name: 'Deno', category: 'runtime', binary: 'deno', description: 'Secure JavaScript and TypeScript runtime.' },
  { id: 'python3', name: 'Python 3', category: 'runtime', binary: 'python3', description: 'Python runtime.', install: { type: 'package', packages: ['python3'] } },
  { id: 'pip', name: 'pip', category: 'packageManagers', binary: 'pip3', binaries: ['pip3', 'pip'], description: 'Python package installer.', install: { type: 'package', packages: { apt: ['python3-pip'], dnf: ['python3-pip'], yum: ['python3-pip'], pacman: ['python-pip'], zypper: ['python3-pip'], apk: ['py3-pip'] } } },
  { id: 'pipx', name: 'pipx', category: 'packageManagers', binary: 'pipx', description: 'Python application installer.', install: { type: 'package', packages: { apt: ['pipx'], dnf: ['pipx'], yum: ['pipx'], pacman: ['python-pipx'], zypper: ['python3-pipx'], apk: ['pipx'] } } },
  { id: 'go', name: 'Go', category: 'runtime', binary: 'go', aliases: ['golang'], description: 'Go compiler and tooling.', install: { type: 'package', packages: { apt: ['golang-go'], dnf: ['golang'], yum: ['golang'], pacman: ['go'], zypper: ['go'], apk: ['go'] } } },
  { id: 'rust', name: 'Rust', category: 'runtime', binary: 'rustc', aliases: ['cargo'], description: 'Rust compiler and cargo.', install: { type: 'package', packages: { apt: ['rustc', 'cargo'], dnf: ['rust', 'cargo'], yum: ['rust', 'cargo'], pacman: ['rust'], zypper: ['rust', 'cargo'], apk: ['rust', 'cargo'] } } },
  { id: 'java', name: 'Java', category: 'runtime', binary: 'java', description: 'Java runtime and JDK.', install: { type: 'package', packages: { apt: ['openjdk-17-jdk'], dnf: ['java-17-openjdk-devel'], yum: ['java-17-openjdk-devel'], pacman: ['jdk-openjdk'], zypper: ['java-17-openjdk-devel'], apk: ['openjdk17'] } } },
  { id: 'maven', name: 'Maven', category: 'buildOps', binary: 'mvn', description: 'Java build and dependency tool.', install: { type: 'package', packages: ['maven'] } },
  { id: 'gradle', name: 'Gradle', category: 'buildOps', binary: 'gradle', description: 'Build automation tool.', install: { type: 'package', packages: ['gradle'] } },
  { id: 'php', name: 'PHP', category: 'runtime', binary: 'php', description: 'PHP runtime.', install: { type: 'package', packages: { apt: ['php-cli'], dnf: ['php-cli'], yum: ['php-cli'], pacman: ['php'], zypper: ['php8'], apk: ['php'] } } },
  { id: 'php-fpm', name: 'PHP-FPM', category: 'runtime', binary: 'php-fpm', description: 'PHP FastCGI process manager.', service: 'php-fpm', install: { type: 'package', packages: { apt: ['php-fpm'], dnf: ['php-fpm'], yum: ['php-fpm'], pacman: ['php-fpm'], zypper: ['php8-fpm'], apk: ['php-fpm'] } } },
  { id: 'composer', name: 'Composer', category: 'packageManagers', binary: 'composer', description: 'PHP dependency manager.', install: { type: 'package', packages: ['composer'] } },
  { id: 'ruby', name: 'Ruby', category: 'runtime', binary: 'ruby', description: 'Ruby runtime.', install: { type: 'package', packages: ['ruby'] } },
  { id: 'gem', name: 'RubyGems', category: 'packageManagers', binary: 'gem', description: 'Ruby package manager.', install: { type: 'package', packages: { apt: ['ruby-full'], dnf: ['rubygems'], yum: ['rubygems'], pacman: ['ruby'], zypper: ['rubygem-bundler'], apk: ['ruby'] } } },

  { id: 'git', name: 'Git', category: 'buildOps', binary: 'git', description: 'Version control system.', install: { type: 'package', packages: ['git'] } },
  { id: 'curl', name: 'curl', category: 'buildOps', binary: 'curl', description: 'HTTP client and transfer tool.', install: { type: 'package', packages: ['curl'] } },
  { id: 'wget', name: 'wget', category: 'buildOps', binary: 'wget', description: 'Network downloader.', install: { type: 'package', packages: ['wget'] } },
  { id: 'jq', name: 'jq', category: 'buildOps', binary: 'jq', description: 'JSON processor.', install: { type: 'package', packages: ['jq'] } },
  { id: 'yq', name: 'yq', category: 'buildOps', binary: 'yq', description: 'YAML processor.', install: { type: 'package', packages: ['yq'] } },
  { id: 'make', name: 'make', category: 'buildOps', binary: 'make', description: 'Build automation utility.', install: { type: 'package', packages: ['make'] } },
  { id: 'gcc', name: 'GCC', category: 'buildOps', binary: 'gcc', description: 'C and C++ compiler toolchain.', install: { type: 'package', packages: { apt: ['build-essential'], dnf: ['gcc', 'gcc-c++', 'make'], yum: ['gcc', 'gcc-c++', 'make'], pacman: ['base-devel'], zypper: ['gcc', 'gcc-c++', 'make'], apk: ['build-base'] } } },
  { id: 'cmake', name: 'CMake', category: 'buildOps', binary: 'cmake', description: 'Cross-platform build system.', install: { type: 'package', packages: ['cmake'] } },
  { id: 'tmux', name: 'tmux', category: 'buildOps', binary: 'tmux', description: 'Terminal multiplexer.', install: { type: 'package', packages: ['tmux'] } },
  { id: 'htop', name: 'htop', category: 'buildOps', binary: 'htop', description: 'Interactive process viewer.', install: { type: 'package', packages: ['htop'] } },
  { id: 'unzip', name: 'unzip', category: 'buildOps', binary: 'unzip', description: 'Zip archive extractor.', install: { type: 'package', packages: ['unzip'] } },
  { id: 'rsync', name: 'rsync', category: 'buildOps', binary: 'rsync', description: 'File synchronization utility.', install: { type: 'package', packages: ['rsync'] } },
  { id: 'ripgrep', name: 'ripgrep', category: 'buildOps', binary: 'rg', aliases: ['rg'], description: 'Fast recursive text search.', install: { type: 'package', packages: { apt: ['ripgrep'], dnf: ['ripgrep'], yum: ['ripgrep'], pacman: ['ripgrep'], zypper: ['ripgrep'], apk: ['ripgrep'] } } },
  { id: 'fd', name: 'fd', category: 'buildOps', binary: 'fd', binaries: ['fd', 'fdfind'], description: 'Fast file finder.', install: { type: 'package', packages: { apt: ['fd-find'], dnf: ['fd-find'], yum: ['fd-find'], pacman: ['fd'], zypper: ['fd'], apk: ['fd'] } } },

  { id: 'ufw', name: 'ufw', category: 'securityNetwork', binary: 'ufw', description: 'Uncomplicated firewall.', service: 'ufw', install: { type: 'package', packages: ['ufw'] } },
  { id: 'firewalld', name: 'firewalld', category: 'securityNetwork', binary: 'firewall-cmd', description: 'Dynamic firewall manager.', service: 'firewalld', install: { type: 'package', packages: ['firewalld'] } },
  { id: 'fail2ban', name: 'Fail2ban', category: 'securityNetwork', binary: 'fail2ban-client', description: 'Log-based intrusion prevention.', service: 'fail2ban', install: { type: 'package', packages: ['fail2ban'] } },
  { id: 'openssl', name: 'OpenSSL', category: 'securityNetwork', binary: 'openssl', description: 'TLS and cryptography toolkit.', install: { type: 'package', packages: ['openssl'] } },
  { id: 'nmap', name: 'nmap', category: 'securityNetwork', binary: 'nmap', description: 'Network scanner.', install: { type: 'package', packages: ['nmap'] } },
  { id: 'tcpdump', name: 'tcpdump', category: 'securityNetwork', binary: 'tcpdump', description: 'Packet capture tool.', install: { type: 'package', packages: ['tcpdump'] } },
  { id: 'netcat', name: 'netcat', category: 'securityNetwork', binary: 'nc', aliases: ['nc'], description: 'TCP and UDP utility.', install: { type: 'package', packages: { apt: ['netcat-openbsd'], dnf: ['nmap-ncat'], yum: ['nmap-ncat'], pacman: ['gnu-netcat'], zypper: ['netcat-openbsd'], apk: ['netcat-openbsd'] } } },
  { id: 'wireguard', name: 'WireGuard', category: 'securityNetwork', binary: 'wg', description: 'VPN tunnel tools.', service: 'wg-quick@wg0', install: { type: 'package', packages: { apt: ['wireguard-tools'], dnf: ['wireguard-tools'], yum: ['wireguard-tools'], pacman: ['wireguard-tools'], zypper: ['wireguard-tools'], apk: ['wireguard-tools'] } } },

  { id: 'claude', name: 'Claude Code', category: 'aiAgents', binary: 'claude', aliases: ['anthropic'], description: 'Anthropic agent CLI.', install: { type: 'npm', packageName: '@anthropic-ai/claude-code' } },
  { id: 'codex', name: 'Codex CLI', category: 'aiAgents', binary: 'codex', aliases: ['openai'], description: 'OpenAI agent CLI.', install: { type: 'npm', packageName: '@openai/codex' } },
  { id: 'gemini', name: 'Gemini CLI', category: 'aiAgents', binary: 'gemini', aliases: ['gemmni', 'google'], description: 'Google Gemini agent CLI.', install: { type: 'npm', packageName: '@google/gemini-cli' } },
  { id: 'aider', name: 'Aider', category: 'aiAgents', binary: 'aider', description: 'AI pair programming CLI.', install: { type: 'pipx', packageName: 'aider-chat' } },
  { id: 'ollama', name: 'Ollama', category: 'aiAgents', binary: 'ollama', description: 'Local model runner.', service: 'ollama' },
  { id: 'langchain-cli', name: 'LangChain CLI', category: 'aiAgents', binary: 'langchain', description: 'LangChain project CLI.', install: { type: 'pipx', packageName: 'langchain-cli' } },

  { id: 'pm2', name: 'PM2', category: 'processManagers', binary: 'pm2', description: 'Node.js process manager.', install: { type: 'npm', packageName: 'pm2' } },
  { id: 'supervisor', name: 'Supervisor', category: 'processManagers', binary: 'supervisorctl', description: 'Process control system.', service: 'supervisor', install: { type: 'package', packages: ['supervisor'] } },
  { id: 'systemd', name: 'systemd', category: 'processManagers', binary: 'systemctl', description: 'Linux service manager.' },
  { id: 'cron', name: 'cron', category: 'processManagers', binary: 'crontab', description: 'Scheduled job manager.', service: 'cron', install: { type: 'package', packages: { apt: ['cron'], dnf: ['cronie'], yum: ['cronie'], pacman: ['cronie'], zypper: ['cron'], apk: ['dcron'] } } },
  { id: 'logrotate', name: 'logrotate', category: 'processManagers', binary: 'logrotate', description: 'Log rotation utility.', install: { type: 'package', packages: ['logrotate'] } },
]

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function packageNamesFor(spec: PackageSpec, manager: LinuxPackageManager) {
  if (Array.isArray(spec)) return spec
  return spec[manager]
    ?? spec.apt
    ?? spec.dnf
    ?? spec.yum
    ?? spec.pacman
    ?? spec.zypper
    ?? spec.apk
    ?? DEFAULT_PACKAGE_SPEC[manager]
}

function packageArgs(spec: PackageSpec, manager: LinuxPackageManager) {
  return packageNamesFor(spec, manager).filter(Boolean).map(shellQuote).join(' ')
}

function noRecipeCommand(manager: LinuxPackageManager) {
  return `echo "No ${manager} package recipe is available for this tool"; return 127`
}

function packageActionCommand(spec: PackageSpec, manager: LinuxPackageManager, action: 'install' | 'upgrade' | 'uninstall') {
  const args = packageArgs(spec, manager)
  if (!args) return noRecipeCommand(manager)

  if (manager === 'apt') {
    if (action === 'install') return `sb_root env DEBIAN_FRONTEND=noninteractive apt-get update && sb_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ${args}`
    if (action === 'upgrade') return `sb_root env DEBIAN_FRONTEND=noninteractive apt-get update && sb_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade ${args}`
    return `sb_root env DEBIAN_FRONTEND=noninteractive apt-get remove -y ${args}`
  }

  if (manager === 'dnf') {
    if (action === 'uninstall') return `sb_root dnf remove -y ${args}`
    return `sb_root dnf ${action === 'upgrade' ? 'upgrade' : 'install'} -y ${args}`
  }

  if (manager === 'yum') {
    if (action === 'uninstall') return `sb_root yum remove -y ${args}`
    return `sb_root yum ${action === 'upgrade' ? 'update' : 'install'} -y ${args}`
  }

  if (manager === 'pacman') {
    if (action === 'uninstall') return `sb_root pacman -Rns --noconfirm ${args}`
    return `sb_root pacman -S --noconfirm ${args}`
  }

  if (manager === 'zypper') {
    if (action === 'uninstall') return `sb_root zypper --non-interactive remove ${args}`
    return `sb_root zypper --non-interactive ${action === 'upgrade' ? 'update' : 'install'} ${args}`
  }

  if (action === 'uninstall') return `sb_root apk del ${args}`
  return `sb_root apk ${action === 'upgrade' ? 'upgrade' : 'add --no-cache'} ${args}`
}

function rootHelperScript() {
  return `
sb_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
  else
    echo "Root privileges are required and sudo is not available"
    return 126
  fi
}
`.trim()
}

function buildPackageManagerCommand(recipe: PackageInstallRecipe, action: 'install' | 'upgrade' | 'uninstall') {
  return `
${rootHelperScript()}
sb_package_action() {
  if command -v apt-get >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'apt', action)}
  elif command -v dnf >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'dnf', action)}
  elif command -v yum >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'yum', action)}
  elif command -v pacman >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'pacman', action)}
  elif command -v zypper >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'zypper', action)}
  elif command -v apk >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'apk', action)}
  else
    echo "No supported package manager found"
    return 127
  fi
}
sb_package_action
`.trim()
}

function buildNpmCommand(recipe: NpmInstallRecipe, action: 'install' | 'upgrade' | 'uninstall') {
  const packageName = action === 'upgrade' ? `${recipe.packageName}@latest` : recipe.packageName
  if (action === 'uninstall') {
    return `command -v npm >/dev/null 2>&1 || { echo "npm is required for this action"; exit 127; }\nnpm uninstall -g ${shellQuote(recipe.packageName)}`
  }
  return `command -v npm >/dev/null 2>&1 || { echo "npm is required for this action"; exit 127; }\nnpm install -g ${shellQuote(packageName)}`
}

function buildPipxCommand(recipe: PipxInstallRecipe, action: 'install' | 'upgrade' | 'uninstall') {
  if (action === 'uninstall') {
    return `command -v pipx >/dev/null 2>&1 || { echo "pipx is required for this action"; exit 127; }\npipx uninstall ${shellQuote(recipe.packageName)}`
  }
  if (action === 'upgrade') {
    return `command -v pipx >/dev/null 2>&1 || { echo "pipx is required for this action"; exit 127; }\npipx upgrade ${shellQuote(recipe.packageName)}`
  }
  return `command -v pipx >/dev/null 2>&1 || { echo "pipx is required for this action"; exit 127; }\npipx install ${shellQuote(recipe.packageName)}`
}

function buildInstallRecipeCommand(recipe: InstallRecipe, action: 'install' | 'upgrade' | 'uninstall') {
  if (recipe.type === 'package') return buildPackageManagerCommand(recipe, action)
  if (recipe.type === 'npm') return buildNpmCommand(recipe, action)
  return buildPipxCommand(recipe, action)
}

function buildToolCheckCommand(tool: ToolDefinition) {
  const candidates = [tool.binary, ...(tool.binaries ?? [])]
  const candidateArgs = Array.from(new Set(candidates)).map(shellQuote).join(' ')
  const versionCommand = tool.versionCommand ?? '"$found" --version 2>&1 | head -n 1'
  const service = tool.service ? shellQuote(tool.service) : ''

  return `
found=""
for candidate in ${candidateArgs}; do
  if command -v "$candidate" >/dev/null 2>&1; then
    found="$candidate"
    break
  fi
done
if [ -n "$found" ]; then
  printf '__SB_INSTALLED=1\\n'
  printf '__SB_BINARY=%s\\n' "$found"
  printf '__SB_PATH=%s\\n' "$(command -v "$found")"
  version="$(${versionCommand} || true)"
  printf '__SB_VERSION=%s\\n' "$version"
else
  printf '__SB_INSTALLED=0\\n'
fi
${tool.service ? `
if command -v systemctl >/dev/null 2>&1; then
  active="$(systemctl is-active ${service} 2>/dev/null || true)"
  enabled="$(systemctl is-enabled ${service} 2>/dev/null || true)"
  printf '__SB_SERVICE_ACTIVE=%s\\n' "$active"
  printf '__SB_SERVICE_ENABLED=%s\\n' "$enabled"
else
  printf '__SB_SERVICE_ACTIVE=systemctl unavailable\\n'
  printf '__SB_SERVICE_ENABLED=systemctl unavailable\\n'
fi
` : ''}
`.trim()
}

function buildServiceCommand(tool: ToolDefinition, action: Exclude<ToolAction, 'check' | 'install' | 'upgrade' | 'uninstall'>) {
  if (!tool.service) throw new Error('This tool has no service unit')
  const service = shellQuote(tool.service)

  if (action === 'logs') {
    return `command -v journalctl >/dev/null 2>&1 || { echo "journalctl is not available"; exit 127; }\njournalctl -u ${service} -n 120 --no-pager`
  }

  if (action === 'status') {
    return `command -v systemctl >/dev/null 2>&1 || { echo "systemctl is not available"; exit 127; }\nsystemctl status ${service} --no-pager`
  }

  return `
${rootHelperScript()}
command -v systemctl >/dev/null 2>&1 || { echo "systemctl is not available"; exit 127; }
sb_root systemctl ${action} ${service}
systemctl status ${service} --no-pager
`.trim()
}

export function buildToolActionCommand(tool: ToolDefinition, action: ToolAction) {
  if (action === 'check') return buildToolCheckCommand(tool)

  const actionBody = action === 'install' || action === 'upgrade' || action === 'uninstall'
    ? tool.install
      ? buildInstallRecipeCommand(tool.install, action)
      : 'echo "Install recipe is not available for this tool"; exit 127'
    : buildServiceCommand(tool, action)

  return `
sb_action_status=0
${actionBody} || sb_action_status=$?
printf '\\n__SB_ACTION_EXIT=%s\\n' "$sb_action_status"
printf '\\n--- ShellBeam status ---\\n'
${buildToolCheckCommand(tool)}
exit "$sb_action_status"
`.trim()
}

function parseMarker(output: string, marker: string) {
  return output.split('\n')
    .find((line) => line.startsWith(`${marker}=`))
    ?.slice(marker.length + 1)
    .trim()
}

export function parseToolStatus(output: string): ToolStatus {
  const installedMarker = parseMarker(output, '__SB_INSTALLED')
  const installed = installedMarker === '1' ? true : installedMarker === '0' ? false : null

  return {
    installed,
    path: parseMarker(output, '__SB_PATH') || undefined,
    version: parseMarker(output, '__SB_VERSION') || undefined,
    serviceActive: parseMarker(output, '__SB_SERVICE_ACTIVE') || undefined,
    serviceEnabled: parseMarker(output, '__SB_SERVICE_ENABLED') || undefined,
    checkedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }
}

function getCategoryLabel(category: ToolCategoryId) {
  return TOOL_CATEGORIES.find((item) => item.id === category)?.label ?? category
}

function getToolLogoSlug(tool: ToolDefinition) {
  return tool.logoSlug ?? TOOL_LOGO_SLUGS[tool.id]
}

function getToolInitials(name: string) {
  const words = name
    .replace(/\./g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)

  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

function ToolLogo({ tool, size = 'sm' }: { tool: ToolDefinition; size?: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const logoSlug = getToolLogoSlug(tool)
  const dimensions = size === 'lg' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-xl'
  const imageSize = size === 'lg' ? 'h-7 w-7' : 'h-5 w-5'

  useEffect(() => {
    setFailed(false)
  }, [logoSlug, tool.id])

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center border border-border/60 bg-background/80 shadow-sm',
        dimensions,
      )}
      title={tool.name}
      aria-hidden="true"
    >
      {logoSlug && !failed ? (
        <img
          src={`${SIMPLE_ICONS_BASE_URL}/${logoSlug}`}
          alt=""
          className={cn('object-contain', imageSize)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={cn('font-semibold text-[color:var(--workspace-primary-300)]', size === 'lg' ? 'text-sm' : 'text-[11px]')}>
          {getToolInitials(tool.name)}
        </span>
      )}
    </div>
  )
}

function getStatusBadge(status: ToolStatus | undefined) {
  if (!status || status.installed === null) return { label: 'Unknown', className: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
  if (status.installed) return { label: 'Installed', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
  return { label: 'Missing', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' }
}

function getServiceBadge(status: ToolStatus | undefined) {
  const value = status?.serviceActive
  if (!value) return { label: 'No service', className: 'border-slate-500/30 bg-slate-500/10 text-slate-300' }
  if (value === 'active') return { label: 'active', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
  if (value === 'failed') return { label: 'failed', className: 'border-red-500/30 bg-red-500/10 text-red-300' }
  return { label: value, className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' }
}

function getActionIcon(action: ToolAction) {
  if (action === 'check') return PackageSearch
  if (action === 'install') return PackagePlus
  if (action === 'upgrade') return Download
  if (action === 'uninstall') return Trash2
  if (action === 'start') return Play
  if (action === 'stop') return Square
  if (action === 'restart') return RotateCw
  if (action === 'enable') return Power
  if (action === 'disable') return PowerOff
  if (action === 'status') return TerminalSquare
  return PackageOpen
}

function formatInstallType(recipe?: InstallRecipe) {
  if (!recipe) return 'Status only'
  if (recipe.type === 'package') return 'System package'
  if (recipe.type === 'npm') return 'npm global'
  return 'pipx app'
}

function toolMatchesSearch(tool: ToolDefinition, query: string) {
  if (!query) return true
  const haystack = [
    tool.name,
    tool.id,
    tool.binary,
    tool.description,
    getCategoryLabel(tool.category),
    ...(tool.aliases ?? []),
  ].join(' ').toLowerCase()
  return haystack.includes(query)
}

function getInitialManagedHostId(hosts: HostProfile[], selectedHostId?: string | null, hostAddress?: string | null) {
  const preferredHost = resolveWorkspaceHost(hosts, { selectedHostId, hostAddress })
  return preferredHost?.id ?? hosts[0]?.id ?? ''
}

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

function formatAge(timestamp?: number) {
  if (!timestamp) return '未扫描'
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function getInstalledToolSearchValues(inventory: WorkspaceInventory | undefined) {
  return inventory?.tools.flatMap((tool) => [
    tool.name,
    tool.id,
    tool.binary,
    tool.path,
    tool.version,
    tool.category,
  ]) ?? []
}

function getProjectSearchValues(inventory: WorkspaceInventory | undefined) {
  return inventory?.projects.flatMap((project) => [
    project.name,
    project.kind,
    project.path,
  ]) ?? []
}

function HostStatusIcon({ state }: { state?: HostInventoryState }) {
  if (state?.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
  if (state?.inventory || state?.status === 'ready') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
  return <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />
}

function HostNetworkLine({ network }: { network?: HostNetworkDisplay }) {
  if (!network) return null
  return <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{network.resolvedLocationLabel}</div>
}

export function WorkspaceToolManagerApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  onOpenTerminal,
}: WorkspaceToolManagerAppProps) {
  const [category, setCategory] = useState<ToolCategoryId | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedToolId, setSelectedToolId] = useState(TOOL_CATALOG[0].id)
  const [statuses, setStatuses] = useState<Record<string, ToolStatus>>({})
  const [running, setRunning] = useState<{ toolId: string; action: ToolAction } | null>(null)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [managedHostId, setManagedHostId] = useState(() => getInitialManagedHostId(hosts, selectedHostId, hostAddress))
  const [detailOpen, setDetailOpen] = useState(false)
  const sharedInventoryStates = useWorkspaceInventoryStates()
  const [inventoryStates, setInventoryStates] = useState<Record<string, HostInventoryState>>(() => {
    const shared = selectWorkspaceInventoryStatesForHosts(hosts)
    return Object.entries(loadWorkspaceInventoryCache(hosts)).reduce<Record<string, HostInventoryState>>((next, [key, entry]) => {
      next[key] = { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
      return next
    }, { ...shared })
  })

  const host = useMemo(() => hosts.find((entry) => entry.id === managedHostId) ?? null, [hosts, managedHostId])
  const networkByAddress = useHostNetworkMetadata(hosts.map((entry) => entry.address))

  const query = searchQuery.trim().toLowerCase()
  const visibleTools = useMemo(
    () => TOOL_CATALOG.filter((tool) => (category === 'all' || tool.category === category) && toolMatchesSearch(tool, query)),
    [category, query],
  )

  const selectedTool = useMemo(
    () => visibleTools.find((tool) => tool.id === selectedToolId)
      ?? TOOL_CATALOG.find((tool) => tool.id === selectedToolId)
      ?? visibleTools[0]
      ?? TOOL_CATALOG[0],
    [selectedToolId, visibleTools],
  )

  const selectedStatus = statuses[selectedTool.id]
  const checkedCount = Object.values(statuses).filter((status) => status.checkedAt).length
  const installedCount = Object.values(statuses).filter((status) => status.installed).length

  async function runRemoteCommand(command: string) {
    if (!host) throw new Error('No host selected')
    return runWorkspaceRemoteCommand({
      host,
      resolveAuthSecret,
      command,
    })
  }

  async function runToolAction(action: ToolAction, tool = selectedTool, options: { silent?: boolean } = {}) {
    if (!host) return
    if ((action === 'uninstall' || action === 'stop' || action === 'restart' || action === 'disable') && !options.silent) {
      const confirmed = window.confirm(`${action} ${tool.name}?`)
      if (!confirmed) return
    }

    setRunning({ toolId: tool.id, action })
    setError('')
    if (!options.silent) {
      setOutput('')
    }

    try {
      const command = buildToolActionCommand(tool, action)
      const result = await runRemoteCommand(command)
      const combined = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ''].filter(Boolean).join('\n')
      const displayOutput = combined || `${action} completed`

      if (displayOutput.includes('__SB_INSTALLED=')) {
        setStatuses((current) => ({
          ...current,
          [tool.id]: parseToolStatus(displayOutput),
        }))
      }

      if (!options.silent) {
        setOutput(displayOutput)
      }

      if (result.exitCode !== 0) {
        setError(`Remote command exited with ${result.exitCode}`)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      if (!options.silent) setOutput(message)
    } finally {
      setRunning(null)
    }
  }

  async function scanVisibleTools() {
    if (!host) return
    for (const tool of visibleTools.slice(0, 24)) {
      await runToolAction('check', tool, { silent: true })
    }
  }

  useEffect(() => {
    setStatuses({})
    setOutput('')
    setError('')
    setDetailOpen(false)
  }, [host?.id])

  useEffect(() => {
    setManagedHostId((current) => {
      if (hosts.some((entry) => entry.id === current)) return current
      return getInitialManagedHostId(hosts, selectedHostId, hostAddress)
    })
  }, [hostAddress, hosts, selectedHostId])

  useEffect(() => {
    setInventoryStates((prev) => ({ ...prev, ...selectWorkspaceInventoryStatesForHosts(hosts, sharedInventoryStates) }))
  }, [hosts, sharedInventoryStates])

  useEffect(() => {
    let cancelled = false
    void loadWorkspaceInventoryPersistedCache(hosts).then((cache) => {
      if (cancelled) return
      const sharedReadyStates = createReadyWorkspaceInventoryStates(cache)
      mergeWorkspaceInventoryStates(sharedReadyStates)
      setInventoryStates((prev) => {
        const next: Record<string, HostInventoryState> = {}
        hosts.forEach((entry) => {
          const key = hostKey(entry)
          const cached = cache[key]
          const existing = prev[key]
          if (existing?.status === 'error') {
            next[key] = existing
          } else if (cached) {
            next[key] = { status: 'ready', inventory: cached.inventory, updatedAt: cached.updatedAt }
          } else if (existing) {
            next[key] = existing
          } else {
            next[key] = { status: 'idle' }
          }
        })
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [hosts])

  useEffect(() => {
    if (!visibleTools.some((tool) => tool.id === selectedToolId)) {
      setSelectedToolId(visibleTools[0]?.id ?? TOOL_CATALOG[0].id)
    }
  }, [selectedToolId, visibleTools])

  useEffect(() => {
    if (!host || statuses[selectedTool.id]?.checkedAt) return
    void runToolAction('check', selectedTool, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, selectedTool.id])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title="Tool Manager"
        description="Connect a remote host to manage common tools and services here."
      />
    )
  }

  const installActions: ToolAction[] = ['check', 'install', 'upgrade', 'uninstall']
  const serviceActions: ToolAction[] = ['status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs']
  const statusBadge = getStatusBadge(selectedStatus)

  return (
    <div data-testid="workspace-tool-manager-app" className="space-y-4">
      <WorkspacePanelHeader
        className="border-b border-[color:var(--workspace-border-strong)]"
        eyebrowClassName="text-[var(--workspace-text-subtle)]"
        titleClassName="text-[var(--workspace-text-strong)]"
        descriptionClassName="text-[var(--workspace-text-muted)]"
        eyebrow="Tool Manager"
        title="Common Services & Toolchains"
        description="在当前 VPS 上扫描常用工具和服务，并执行安装、升级、启停和日志操作。"
        actions={
          <button
            type="button"
            onClick={() => void scanVisibleTools()}
            disabled={running !== null || visibleTools.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] px-3 py-2 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[rgba(30,44,60,0.82)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', running?.action === 'check' && 'animate-spin')} />
            Scan Visible
          </button>
        }
        contentClassName="space-y-3"
      >
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">{hosts.length} VPS</span>
          <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">{TOOL_CATALOG.length} tools</span>
          <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">{checkedCount} checked</span>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">{installedCount} installed</span>
        </div>
      </WorkspacePanelHeader>

      <div className="grid min-h-[34rem] gap-4 xl:grid-cols-[minmax(22rem,0.72fr)_minmax(15rem,0.44fr)_minmax(0,1.35fr)]">
        <WorkspaceServerList
          hosts={hosts}
          totalCount={hosts.length}
          selectedKey={host.id}
          getHostKey={(entry) => entry.id}
          onSelect={(key) => setManagedHostId(key)}
          itemTestIdPrefix="workspace-tool-host"
          renderStatusIcon={(entry) => <HostStatusIcon state={inventoryStates[hostKey(entry)]} />}
          getStatusBadge={(entry) => {
            const state = inventoryStates[hostKey(entry)]
            if (state?.status === 'error') return { label: '无法访问', tone: 'bad' }
            return undefined
          }}
          getPrimaryBadge={(entry) => {
            const state = inventoryStates[hostKey(entry)]
            if (!state?.inventory) return { label: entry.authType }
            return { label: `${state.inventory.tools.length} 工具`, tone: 'info' }
          }}
          renderRegionLine={(entry) => <HostNetworkLine network={networkByAddress[entry.address]} />}
          getSearchData={(entry) => {
            const state = inventoryStates[hostKey(entry)]
            const network = networkByAddress[entry.address]
            return {
              network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
              system: [state?.inventory?.resource.os, state?.inventory?.resource.kernel],
              tools: getInstalledToolSearchValues(state?.inventory),
              projects: getProjectSearchValues(state?.inventory),
            }
          }}
          getResourceMetrics={(entry) => {
            const inventory = inventoryStates[hostKey(entry)]?.inventory
            if (!inventory) return undefined
            return {
              cpuPercent: inventory?.resource.cpuPercent,
              memoryPercent: inventory?.resource.memoryPercent,
              diskPercent: inventory?.resource.diskPercent,
              cpuDetail: inventory?.resource.uptime,
              memoryDetail: inventory?.resource.memoryText,
              diskDetail: inventory?.resource.diskText,
            }
          }}
          renderFooter={(entry) => {
            const state = inventoryStates[hostKey(entry)]
            return (
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--workspace-text-subtle)]">
                <span>{formatAge(state?.updatedAt)}</span>
                {state?.status === 'error' ? <span className="truncate text-red-200">无法访问</span> : <span className="truncate">{state?.inventory?.resource.os || '版本待扫描'}</span>}
              </div>
            )
          }}
          onRowDoubleClick={(entry) => onOpenTerminal?.(entry)}
        />

        <aside className="space-y-3 rounded-xl border border-border/60 bg-card p-3">
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={cn(
              'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
              category === 'all' ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
          >
            <span>All tools</span>
            <span className="text-xs">{TOOL_CATALOG.length}</span>
          </button>
          {TOOL_CATEGORIES.map((item) => {
            const count = TOOL_CATALOG.filter((tool) => tool.category === item.id).length
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setCategory(item.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
                  category === item.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <span className="truncate">{item.label}</span>
                <span className="text-xs">{count}</span>
              </button>
            )
          })}
        </aside>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search nginx, docker, node, codex..."
                className="h-10 w-full rounded-lg border border-border/60 bg-background/80 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="text-xs text-muted-foreground">{visibleTools.length} visible</div>
          </div>
          <div data-testid="workspace-tool-catalog" className="max-h-[32rem] overflow-auto">
            {visibleTools.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted-foreground">No matching tools.</div>
            ) : (
              visibleTools.map((tool) => {
                const isSelected = tool.id === selectedTool.id
                const toolStatus = statuses[tool.id]
                const badge = getStatusBadge(toolStatus)
                const service = getServiceBadge(toolStatus)
                return (
                  <button
                    key={tool.id}
                    type="button"
                    data-testid={`workspace-tool-card-${tool.id}`}
                    onClick={() => {
                      setSelectedToolId(tool.id)
                      setDetailOpen(true)
                    }}
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 border-b border-border/40 px-4 py-3 text-left text-sm transition-colors last:border-b-0',
                      isSelected ? 'bg-primary/10' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ToolLogo tool={tool} />
                        <div className="min-w-0">
                          <span className="block truncate font-semibold">{tool.name}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{tool.binary}</span>
                        </div>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">{tool.description}</div>
                    </div>
                    <div>
                      <span className={cn('rounded-full border px-2 py-1 text-[11px] font-medium', badge.className)}>
                        {badge.label}
                      </span>
                    </div>
                    <div>
                      <span className={cn('rounded-full border px-2 py-1 text-[11px] font-medium', tool.service ? service.className : 'border-slate-500/30 bg-slate-500/10 text-slate-300')}>
                        {tool.service ? service.label : 'binary'}
                      </span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </section>

      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="w-[min(72rem,calc(100vw-2rem))] rounded-xl border border-border/60 bg-card p-0">
          <section className="min-w-0 p-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(24rem,0.75fr)]">
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{getCategoryLabel(selectedTool.category)}</div>
                    <h3 className="mt-2 truncate text-2xl font-semibold tracking-tight">{selectedTool.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{selectedTool.description}</p>
                  </div>
                  <ToolLogo tool={selectedTool} size="lg" />
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                    <div className="text-muted-foreground">Binary</div>
                    <div className="mt-1 truncate font-medium">{selectedTool.binary}</div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                    <div className="text-muted-foreground">Install</div>
                    <div className="mt-1 truncate font-medium">{formatInstallType(selectedTool.install)}</div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                    <div className="text-muted-foreground">Status</div>
                    <div className="mt-1 flex items-center gap-1.5 font-medium">
                      {selectedStatus?.installed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />}
                      {statusBadge.label}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                    <div className="text-muted-foreground">Service</div>
                    <div className="mt-1 truncate font-medium">{selectedTool.service ?? 'none'}</div>
                  </div>
                </div>

                {selectedStatus?.version && (
                  <div className="mt-3 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">Version</div>
                    <div className="mt-1 break-words font-medium">{selectedStatus.version}</div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Package Actions</div>
                  <div className="grid grid-cols-2 gap-2">
                    {installActions.map((action) => {
                      const Icon = getActionIcon(action)
                      const disabled = running !== null || (action !== 'check' && !selectedTool.install)
                      return (
                        <button
                          key={action}
                          type="button"
                          onClick={() => void runToolAction(action)}
                          disabled={disabled}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium capitalize hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <Icon className={cn('h-3.5 w-3.5', running?.toolId === selectedTool.id && running.action === action && 'animate-spin')} />
                          {running?.toolId === selectedTool.id && running.action === action ? 'Running' : action}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedTool.service && (
                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Service Actions</div>
                    <div className="grid grid-cols-2 gap-2">
                      {serviceActions.map((action) => {
                        const Icon = getActionIcon(action)
                        return (
                          <button
                            key={action}
                            type="button"
                            onClick={() => void runToolAction(action)}
                            disabled={running !== null}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium capitalize hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <Icon className={cn('h-3.5 w-3.5', running?.toolId === selectedTool.id && running.action === action && 'animate-spin')} />
                            {running?.toolId === selectedTool.id && running.action === action ? 'Running' : action}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="mt-4 flex gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                <CircleAlert className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </section>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Shield className="h-3.5 w-3.5" />
            Remote Output
          </div>
          <div className="text-xs text-muted-foreground">{selectedStatus?.checkedAt ? `Checked ${selectedStatus.checkedAt}` : selectedTool.name}</div>
        </div>
        <pre data-testid="workspace-tool-output" className="mt-3 max-h-[16rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background/70 p-3 text-xs leading-6 text-foreground">
          {output || (running ? 'Running remote command...' : 'No command output yet.')}
        </pre>
      </div>
    </div>
  )
}
