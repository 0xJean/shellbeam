import { t as translate } from './i18n'
import type { WorkspaceToolStatus } from './workspace-tool-status'
import type { CommandRunResult } from './sessions'
import type { VerifiedDiagnosticResult } from './workspace-diagnostics'

export const TOOL_CATEGORIES = [
  { id: 'web', labelKey: 'workspace.tools.category.web' },
  { id: 'database', labelKey: 'workspace.tools.category.database' },
  { id: 'cacheQueue', labelKey: 'workspace.tools.category.cacheQueue' },
  { id: 'containers', labelKey: 'workspace.tools.category.containers' },
  { id: 'runtime', labelKey: 'workspace.tools.category.runtime' },
  { id: 'packageManagers', labelKey: 'workspace.tools.category.packageManagers' },
  { id: 'buildOps', labelKey: 'workspace.tools.category.buildOps' },
  { id: 'securityNetwork', labelKey: 'workspace.tools.category.securityNetwork' },
  { id: 'aiAgents', labelKey: 'workspace.tools.category.aiAgents' },
  { id: 'processManagers', labelKey: 'workspace.tools.category.processManagers' },
] as const

export type ToolCategoryId = (typeof TOOL_CATEGORIES)[number]['id']
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
  descriptionKey: string
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

export type ToolStatus = WorkspaceToolStatus

type TFunction = (key: string, params?: Record<string, string | number>) => string

const DEFAULT_PACKAGE_SPEC = {
  apt: [''],
  dnf: [''],
  yum: [''],
  pacman: [''],
  zypper: [''],
  apk: [''],
} satisfies Record<LinuxPackageManager, string[]>

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'web',
    binary: 'nginx',
    aliases: ['reverse proxy', 'web server'],
    descriptionKey: 'workspace.tools.catalog.nginx.description',
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
    descriptionKey: 'workspace.tools.catalog.apache.description',
    service: 'apache2',
    install: {
      type: 'package',
      packages: { apt: ['apache2'], dnf: ['httpd'], yum: ['httpd'], pacman: ['apache'], zypper: ['apache2'], apk: ['apache2'] },
    },
  },
  { id: 'caddy', name: 'Caddy', category: 'web', binary: 'caddy', descriptionKey: 'workspace.tools.catalog.caddy.description', service: 'caddy', install: { type: 'package', packages: ['caddy'] } },
  { id: 'haproxy', name: 'HAProxy', category: 'web', binary: 'haproxy', descriptionKey: 'workspace.tools.catalog.haproxy.description', service: 'haproxy', install: { type: 'package', packages: ['haproxy'] } },
  { id: 'certbot', name: 'Certbot', category: 'web', binary: 'certbot', descriptionKey: 'workspace.tools.catalog.certbot.description', install: { type: 'package', packages: ['certbot'] } },
  { id: 'traefik', name: 'Traefik', category: 'web', binary: 'traefik', descriptionKey: 'workspace.tools.catalog.traefik.description', service: 'traefik', install: { type: 'package', packages: ['traefik'] } },

  { id: 'mysql', name: 'MySQL', category: 'database', binary: 'mysql', aliases: ['mysqld'], descriptionKey: 'workspace.tools.catalog.mysql.description', service: 'mysql', install: { type: 'package', packages: { apt: ['mysql-server'], dnf: ['mysql-server'], yum: ['mysql-server'], pacman: ['mysql'], zypper: ['mysql'], apk: ['mysql', 'mysql-client'] } } },
  { id: 'mariadb', name: 'MariaDB', category: 'database', binary: 'mariadb', binaries: ['mariadb', 'mysql'], descriptionKey: 'workspace.tools.catalog.mariadb.description', service: 'mariadb', install: { type: 'package', packages: { apt: ['mariadb-server'], dnf: ['mariadb-server'], yum: ['mariadb-server'], pacman: ['mariadb'], zypper: ['mariadb'], apk: ['mariadb', 'mariadb-client'] } } },
  { id: 'postgresql', name: 'PostgreSQL', category: 'database', binary: 'psql', aliases: ['pgsql', 'postgres'], descriptionKey: 'workspace.tools.catalog.postgresql.description', service: 'postgresql', install: { type: 'package', packages: ['postgresql'] } },
  { id: 'sqlite', name: 'SQLite', category: 'database', binary: 'sqlite3', descriptionKey: 'workspace.tools.catalog.sqlite.description', install: { type: 'package', packages: ['sqlite3'] } },
  { id: 'mongodb', name: 'MongoDB', category: 'database', binary: 'mongod', aliases: ['mongo', 'mongosh'], descriptionKey: 'workspace.tools.catalog.mongodb.description', service: 'mongod', install: { type: 'package', packages: { apt: ['mongodb'], dnf: ['mongodb'], yum: ['mongodb'], pacman: ['mongodb'], zypper: ['mongodb'], apk: ['mongodb'] } } },
  { id: 'clickhouse', name: 'ClickHouse', category: 'database', binary: 'clickhouse', descriptionKey: 'workspace.tools.catalog.clickhouse.description', service: 'clickhouse-server', install: { type: 'package', packages: ['clickhouse-server', 'clickhouse-client'] } },

  { id: 'redis', name: 'Redis', category: 'cacheQueue', binary: 'redis-server', aliases: ['redis-cli'], descriptionKey: 'workspace.tools.catalog.redis.description', service: 'redis-server', install: { type: 'package', packages: { apt: ['redis-server'], dnf: ['redis'], yum: ['redis'], pacman: ['redis'], zypper: ['redis'], apk: ['redis'] } } },
  { id: 'memcached', name: 'Memcached', category: 'cacheQueue', binary: 'memcached', descriptionKey: 'workspace.tools.catalog.memcached.description', service: 'memcached', install: { type: 'package', packages: ['memcached'] } },
  { id: 'rabbitmq', name: 'RabbitMQ', category: 'cacheQueue', binary: 'rabbitmqctl', descriptionKey: 'workspace.tools.catalog.rabbitmq.description', service: 'rabbitmq-server', install: { type: 'package', packages: ['rabbitmq-server'] } },
  { id: 'kafka', name: 'Kafka', category: 'cacheQueue', binary: 'kafka-server-start', descriptionKey: 'workspace.tools.catalog.kafka.description', service: 'kafka', install: { type: 'package', packages: ['kafka'] } },

  { id: 'docker', name: 'Docker', category: 'containers', binary: 'docker', descriptionKey: 'workspace.tools.catalog.docker.description', service: 'docker', install: { type: 'package', packages: { apt: ['docker.io'], dnf: ['docker'], yum: ['docker'], pacman: ['docker'], zypper: ['docker'], apk: ['docker'] } } },
  { id: 'docker-compose', name: 'Docker Compose', category: 'containers', binary: 'docker', aliases: ['compose'], descriptionKey: 'workspace.tools.catalog.docker-compose.description', versionCommand: 'docker compose version 2>&1 | head -n 1', install: { type: 'package', packages: { apt: ['docker-compose-plugin'], dnf: ['docker-compose-plugin'], yum: ['docker-compose-plugin'], pacman: ['docker-compose'], zypper: ['docker-compose'], apk: ['docker-compose'] } } },
  { id: 'podman', name: 'Podman', category: 'containers', binary: 'podman', descriptionKey: 'workspace.tools.catalog.podman.description', service: 'podman', install: { type: 'package', packages: ['podman'] } },
  { id: 'containerd', name: 'containerd', category: 'containers', binary: 'containerd', descriptionKey: 'workspace.tools.catalog.containerd.description', service: 'containerd', install: { type: 'package', packages: ['containerd'] } },
  { id: 'kubectl', name: 'kubectl', category: 'containers', binary: 'kubectl', aliases: ['kubernetes'], descriptionKey: 'workspace.tools.catalog.kubectl.description', install: { type: 'package', packages: ['kubectl'] } },
  { id: 'helm', name: 'Helm', category: 'containers', binary: 'helm', descriptionKey: 'workspace.tools.catalog.helm.description', install: { type: 'package', packages: ['helm'] } },
  { id: 'k3s', name: 'k3s', category: 'containers', binary: 'k3s', descriptionKey: 'workspace.tools.catalog.k3s.description', service: 'k3s' },

  { id: 'node', name: 'Node.js', category: 'runtime', binary: 'node', descriptionKey: 'workspace.tools.catalog.node.description', install: { type: 'package', packages: { apt: ['nodejs'], dnf: ['nodejs'], yum: ['nodejs'], pacman: ['nodejs'], zypper: ['nodejs'], apk: ['nodejs'] } } },
  { id: 'npm', name: 'npm', category: 'packageManagers', binary: 'npm', descriptionKey: 'workspace.tools.catalog.npm.description', install: { type: 'package', packages: ['npm'] } },
  { id: 'pnpm', name: 'pnpm', category: 'packageManagers', binary: 'pnpm', descriptionKey: 'workspace.tools.catalog.pnpm.description', install: { type: 'npm', packageName: 'pnpm' } },
  { id: 'yarn', name: 'Yarn', category: 'packageManagers', binary: 'yarn', descriptionKey: 'workspace.tools.catalog.yarn.description', install: { type: 'npm', packageName: 'yarn' } },
  { id: 'bun', name: 'Bun', category: 'runtime', binary: 'bun', descriptionKey: 'workspace.tools.catalog.bun.description', install: { type: 'npm', packageName: 'bun' } },
  { id: 'deno', name: 'Deno', category: 'runtime', binary: 'deno', descriptionKey: 'workspace.tools.catalog.deno.description' },
  { id: 'python3', name: 'Python 3', category: 'runtime', binary: 'python3', descriptionKey: 'workspace.tools.catalog.python3.description', install: { type: 'package', packages: ['python3'] } },
  { id: 'pip', name: 'pip', category: 'packageManagers', binary: 'pip3', binaries: ['pip3', 'pip'], descriptionKey: 'workspace.tools.catalog.pip.description', install: { type: 'package', packages: { apt: ['python3-pip'], dnf: ['python3-pip'], yum: ['python3-pip'], pacman: ['python-pip'], zypper: ['python3-pip'], apk: ['py3-pip'] } } },
  { id: 'pipx', name: 'pipx', category: 'packageManagers', binary: 'pipx', descriptionKey: 'workspace.tools.catalog.pipx.description', install: { type: 'package', packages: { apt: ['pipx'], dnf: ['pipx'], yum: ['pipx'], pacman: ['python-pipx'], zypper: ['python3-pipx'], apk: ['pipx'] } } },
  { id: 'go', name: 'Go', category: 'runtime', binary: 'go', aliases: ['golang'], descriptionKey: 'workspace.tools.catalog.go.description', install: { type: 'package', packages: { apt: ['golang-go'], dnf: ['golang'], yum: ['golang'], pacman: ['go'], zypper: ['go'], apk: ['go'] } } },
  { id: 'rust', name: 'Rust', category: 'runtime', binary: 'rustc', aliases: ['cargo'], descriptionKey: 'workspace.tools.catalog.rust.description', install: { type: 'package', packages: { apt: ['rustc', 'cargo'], dnf: ['rust', 'cargo'], yum: ['rust', 'cargo'], pacman: ['rust'], zypper: ['rust', 'cargo'], apk: ['rust', 'cargo'] } } },
  { id: 'java', name: 'Java', category: 'runtime', binary: 'java', descriptionKey: 'workspace.tools.catalog.java.description', install: { type: 'package', packages: { apt: ['openjdk-17-jdk'], dnf: ['java-17-openjdk-devel'], yum: ['java-17-openjdk-devel'], pacman: ['jdk-openjdk'], zypper: ['java-17-openjdk-devel'], apk: ['openjdk17'] } } },
  { id: 'maven', name: 'Maven', category: 'buildOps', binary: 'mvn', descriptionKey: 'workspace.tools.catalog.maven.description', install: { type: 'package', packages: ['maven'] } },
  { id: 'gradle', name: 'Gradle', category: 'buildOps', binary: 'gradle', descriptionKey: 'workspace.tools.catalog.gradle.description', install: { type: 'package', packages: ['gradle'] } },
  { id: 'php', name: 'PHP', category: 'runtime', binary: 'php', descriptionKey: 'workspace.tools.catalog.php.description', install: { type: 'package', packages: { apt: ['php-cli'], dnf: ['php-cli'], yum: ['php-cli'], pacman: ['php'], zypper: ['php8'], apk: ['php'] } } },
  { id: 'php-fpm', name: 'PHP-FPM', category: 'runtime', binary: 'php-fpm', descriptionKey: 'workspace.tools.catalog.php-fpm.description', service: 'php-fpm', install: { type: 'package', packages: { apt: ['php-fpm'], dnf: ['php-fpm'], yum: ['php-fpm'], pacman: ['php-fpm'], zypper: ['php8-fpm'], apk: ['php-fpm'] } } },
  { id: 'composer', name: 'Composer', category: 'packageManagers', binary: 'composer', descriptionKey: 'workspace.tools.catalog.composer.description', install: { type: 'package', packages: ['composer'] } },
  { id: 'ruby', name: 'Ruby', category: 'runtime', binary: 'ruby', descriptionKey: 'workspace.tools.catalog.ruby.description', install: { type: 'package', packages: ['ruby'] } },
  { id: 'gem', name: 'RubyGems', category: 'packageManagers', binary: 'gem', descriptionKey: 'workspace.tools.catalog.gem.description', install: { type: 'package', packages: { apt: ['ruby-full'], dnf: ['rubygems'], yum: ['rubygems'], pacman: ['ruby'], zypper: ['rubygem-bundler'], apk: ['ruby'] } } },

  { id: 'git', name: 'Git', category: 'buildOps', binary: 'git', descriptionKey: 'workspace.tools.catalog.git.description', install: { type: 'package', packages: ['git'] } },
  { id: 'curl', name: 'curl', category: 'buildOps', binary: 'curl', descriptionKey: 'workspace.tools.catalog.curl.description', install: { type: 'package', packages: ['curl'] } },
  { id: 'wget', name: 'wget', category: 'buildOps', binary: 'wget', descriptionKey: 'workspace.tools.catalog.wget.description', install: { type: 'package', packages: ['wget'] } },
  { id: 'jq', name: 'jq', category: 'buildOps', binary: 'jq', descriptionKey: 'workspace.tools.catalog.jq.description', install: { type: 'package', packages: ['jq'] } },
  { id: 'yq', name: 'yq', category: 'buildOps', binary: 'yq', descriptionKey: 'workspace.tools.catalog.yq.description', install: { type: 'package', packages: ['yq'] } },
  { id: 'make', name: 'make', category: 'buildOps', binary: 'make', descriptionKey: 'workspace.tools.catalog.make.description', install: { type: 'package', packages: ['make'] } },
  { id: 'gcc', name: 'GCC', category: 'buildOps', binary: 'gcc', descriptionKey: 'workspace.tools.catalog.gcc.description', install: { type: 'package', packages: { apt: ['build-essential'], dnf: ['gcc', 'gcc-c++', 'make'], yum: ['gcc', 'gcc-c++', 'make'], pacman: ['base-devel'], zypper: ['gcc', 'gcc-c++', 'make'], apk: ['build-base'] } } },
  { id: 'cmake', name: 'CMake', category: 'buildOps', binary: 'cmake', descriptionKey: 'workspace.tools.catalog.cmake.description', install: { type: 'package', packages: ['cmake'] } },
  { id: 'tmux', name: 'tmux', category: 'buildOps', binary: 'tmux', descriptionKey: 'workspace.tools.catalog.tmux.description', install: { type: 'package', packages: ['tmux'] } },
  { id: 'htop', name: 'htop', category: 'buildOps', binary: 'htop', descriptionKey: 'workspace.tools.catalog.htop.description', install: { type: 'package', packages: ['htop'] } },
  { id: 'unzip', name: 'unzip', category: 'buildOps', binary: 'unzip', descriptionKey: 'workspace.tools.catalog.unzip.description', install: { type: 'package', packages: ['unzip'] } },
  { id: 'rsync', name: 'rsync', category: 'buildOps', binary: 'rsync', descriptionKey: 'workspace.tools.catalog.rsync.description', install: { type: 'package', packages: ['rsync'] } },
  { id: 'ripgrep', name: 'ripgrep', category: 'buildOps', binary: 'rg', aliases: ['rg'], descriptionKey: 'workspace.tools.catalog.ripgrep.description', install: { type: 'package', packages: { apt: ['ripgrep'], dnf: ['ripgrep'], yum: ['ripgrep'], pacman: ['ripgrep'], zypper: ['ripgrep'], apk: ['ripgrep'] } } },
  { id: 'fd', name: 'fd', category: 'buildOps', binary: 'fd', binaries: ['fd', 'fdfind'], descriptionKey: 'workspace.tools.catalog.fd.description', install: { type: 'package', packages: { apt: ['fd-find'], dnf: ['fd-find'], yum: ['fd-find'], pacman: ['fd'], zypper: ['fd'], apk: ['fd'] } } },

  { id: 'ufw', name: 'ufw', category: 'securityNetwork', binary: 'ufw', descriptionKey: 'workspace.tools.catalog.ufw.description', service: 'ufw', install: { type: 'package', packages: ['ufw'] } },
  { id: 'firewalld', name: 'firewalld', category: 'securityNetwork', binary: 'firewall-cmd', descriptionKey: 'workspace.tools.catalog.firewalld.description', service: 'firewalld', install: { type: 'package', packages: ['firewalld'] } },
  { id: 'fail2ban', name: 'Fail2ban', category: 'securityNetwork', binary: 'fail2ban-client', descriptionKey: 'workspace.tools.catalog.fail2ban.description', service: 'fail2ban', install: { type: 'package', packages: ['fail2ban'] } },
  { id: 'openssl', name: 'OpenSSL', category: 'securityNetwork', binary: 'openssl', descriptionKey: 'workspace.tools.catalog.openssl.description', install: { type: 'package', packages: ['openssl'] } },
  { id: 'nmap', name: 'nmap', category: 'securityNetwork', binary: 'nmap', descriptionKey: 'workspace.tools.catalog.nmap.description', install: { type: 'package', packages: ['nmap'] } },
  { id: 'tcpdump', name: 'tcpdump', category: 'securityNetwork', binary: 'tcpdump', descriptionKey: 'workspace.tools.catalog.tcpdump.description', install: { type: 'package', packages: ['tcpdump'] } },
  { id: 'netcat', name: 'netcat', category: 'securityNetwork', binary: 'nc', aliases: ['nc'], descriptionKey: 'workspace.tools.catalog.netcat.description', install: { type: 'package', packages: { apt: ['netcat-openbsd'], dnf: ['nmap-ncat'], yum: ['nmap-ncat'], pacman: ['gnu-netcat'], zypper: ['netcat-openbsd'], apk: ['netcat-openbsd'] } } },
  { id: 'wireguard', name: 'WireGuard', category: 'securityNetwork', binary: 'wg', descriptionKey: 'workspace.tools.catalog.wireguard.description', service: 'wg-quick@wg0', install: { type: 'package', packages: { apt: ['wireguard-tools'], dnf: ['wireguard-tools'], yum: ['wireguard-tools'], pacman: ['wireguard-tools'], zypper: ['wireguard-tools'], apk: ['wireguard-tools'] } } },

  { id: 'claude', name: 'Claude Code', category: 'aiAgents', binary: 'claude', aliases: ['anthropic'], descriptionKey: 'workspace.tools.catalog.claude.description', install: { type: 'npm', packageName: '@anthropic-ai/claude-code' } },
  { id: 'codex', name: 'Codex CLI', category: 'aiAgents', binary: 'codex', aliases: ['openai'], descriptionKey: 'workspace.tools.catalog.codex.description', install: { type: 'npm', packageName: '@openai/codex' } },
  { id: 'gemini', name: 'Gemini CLI', category: 'aiAgents', binary: 'gemini', aliases: ['gemmni', 'google'], descriptionKey: 'workspace.tools.catalog.gemini.description', install: { type: 'npm', packageName: '@google/gemini-cli' } },
  { id: 'aider', name: 'Aider', category: 'aiAgents', binary: 'aider', descriptionKey: 'workspace.tools.catalog.aider.description', install: { type: 'pipx', packageName: 'aider-chat' } },
  { id: 'ollama', name: 'Ollama', category: 'aiAgents', binary: 'ollama', descriptionKey: 'workspace.tools.catalog.ollama.description', service: 'ollama' },
  { id: 'langchain-cli', name: 'LangChain CLI', category: 'aiAgents', binary: 'langchain', descriptionKey: 'workspace.tools.catalog.langchain-cli.description', install: { type: 'pipx', packageName: 'langchain-cli' } },

  { id: 'pm2', name: 'PM2', category: 'processManagers', binary: 'pm2', descriptionKey: 'workspace.tools.catalog.pm2.description', install: { type: 'npm', packageName: 'pm2' } },
  { id: 'supervisor', name: 'Supervisor', category: 'processManagers', binary: 'supervisorctl', descriptionKey: 'workspace.tools.catalog.supervisor.description', service: 'supervisor', install: { type: 'package', packages: ['supervisor'] } },
  { id: 'systemd', name: 'systemd', category: 'processManagers', binary: 'systemctl', descriptionKey: 'workspace.tools.catalog.systemd.description' },
  { id: 'cron', name: 'cron', category: 'processManagers', binary: 'crontab', descriptionKey: 'workspace.tools.catalog.cron.description', service: 'cron', install: { type: 'package', packages: { apt: ['cron'], dnf: ['cronie'], yum: ['cronie'], pacman: ['cronie'], zypper: ['cron'], apk: ['dcron'] } } },
  { id: 'logrotate', name: 'logrotate', category: 'processManagers', binary: 'logrotate', descriptionKey: 'workspace.tools.catalog.logrotate.description', install: { type: 'package', packages: ['logrotate'] } },
]

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellPrint(message: string) {
  return `printf '%s\\n' ${shellQuote(message)}`
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

function noRecipeCommand(manager: LinuxPackageManager, t: TFunction = translate) {
  return `${shellPrint(t('workspace.tools.command.noPackageRecipe', { manager }))}; return 127`
}

function packageActionCommand(spec: PackageSpec, manager: LinuxPackageManager, action: 'install' | 'upgrade' | 'uninstall', t: TFunction = translate) {
  const args = packageArgs(spec, manager)
  if (!args) return noRecipeCommand(manager, t)

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

export function rootHelperScript(t: TFunction = translate) {
  return `
sb_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
  else
    ${shellPrint(t('workspace.tools.command.rootRequired'))}
    return 126
  fi
}
`.trim()
}

function buildPackageManagerCommand(recipe: PackageInstallRecipe, action: 'install' | 'upgrade' | 'uninstall', t: TFunction = translate) {
  return `
${rootHelperScript(t)}
sb_package_action() {
  if command -v apt-get >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'apt', action, t)}
  elif command -v dnf >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'dnf', action, t)}
  elif command -v yum >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'yum', action, t)}
  elif command -v pacman >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'pacman', action, t)}
  elif command -v zypper >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'zypper', action, t)}
  elif command -v apk >/dev/null 2>&1; then
    ${packageActionCommand(recipe.packages, 'apk', action, t)}
  else
    ${shellPrint(t('workspace.tools.command.noSupportedPackageManager'))}
    return 127
  fi
}
sb_package_action
`.trim()
}

function buildNpmCommand(recipe: NpmInstallRecipe, action: 'install' | 'upgrade' | 'uninstall', t: TFunction = translate) {
  const packageName = action === 'upgrade' ? `${recipe.packageName}@latest` : recipe.packageName
  const requireNpm = `command -v npm >/dev/null 2>&1 || { ${shellPrint(t('workspace.tools.command.npmRequired'))}; exit 127; }`
  if (action === 'uninstall') {
    return `${requireNpm}\nnpm uninstall -g ${shellQuote(recipe.packageName)}`
  }
  return `${requireNpm}\nnpm install -g ${shellQuote(packageName)}`
}

function buildPipxCommand(recipe: PipxInstallRecipe, action: 'install' | 'upgrade' | 'uninstall', t: TFunction = translate) {
  const requirePipx = `command -v pipx >/dev/null 2>&1 || { ${shellPrint(t('workspace.tools.command.pipxRequired'))}; exit 127; }`
  if (action === 'uninstall') {
    return `${requirePipx}\npipx uninstall ${shellQuote(recipe.packageName)}`
  }
  if (action === 'upgrade') {
    return `${requirePipx}\npipx upgrade ${shellQuote(recipe.packageName)}`
  }
  return `${requirePipx}\npipx install ${shellQuote(recipe.packageName)}`
}

function buildInstallRecipeCommand(recipe: InstallRecipe, action: 'install' | 'upgrade' | 'uninstall', t: TFunction = translate) {
  if (recipe.type === 'package') return buildPackageManagerCommand(recipe, action, t)
  if (recipe.type === 'npm') return buildNpmCommand(recipe, action, t)
  return buildPipxCommand(recipe, action, t)
}

function buildToolCheckCommand(tool: ToolDefinition, t: TFunction = translate) {
  const candidates = [tool.binary, ...(tool.binaries ?? [])]
  const candidateArgs = Array.from(new Set(candidates)).map(shellQuote).join(' ')
  const versionCommand = (tool.versionCommand ?? '"$found" --version 2>&1').replace(/\s*\|\s*head -n 1\s*$/, '')
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
  version_probe="$( { ${versionCommand}
    sb_version_exit=$?
    printf '\\n__SB_VERSION_EXIT=%s\\n' "$sb_version_exit"
  } | head -c 4096 )"
  version="$(printf '%s\\n' "$version_probe" | head -n 1)"
  printf '__SB_VERSION=%s\\n' "$version"
  printf '%s\\n' "$version_probe" | sed -n '/^__SB_VERSION_EXIT=[0-9][0-9]*$/p'
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
  printf '__SB_SERVICE_ACTIVE=%s\\n' ${shellQuote(t('workspace.tools.command.systemctlUnavailable'))}
  printf '__SB_SERVICE_ENABLED=%s\\n' ${shellQuote(t('workspace.tools.command.systemctlUnavailable'))}
fi
` : ''}
`.trim()
}

function buildServiceCommand(tool: ToolDefinition, action: Exclude<ToolAction, 'check' | 'install' | 'upgrade' | 'uninstall'>, t: TFunction = translate) {
  if (!tool.service) throw new Error(t('workspace.tools.command.noServiceUnit'))
  const service = shellQuote(tool.service)

  if (action === 'logs') {
    return `command -v journalctl >/dev/null 2>&1 || { ${shellPrint(t('workspace.tools.command.journalctlUnavailable'))}; exit 127; }\njournalctl -u ${service} -n 120 --no-pager`
  }

  if (action === 'status') {
    return `command -v systemctl >/dev/null 2>&1 || { ${shellPrint(t('workspace.tools.command.systemctlUnavailable'))}; exit 127; }\nsystemctl status ${service} --no-pager`
  }

  return `
${rootHelperScript(t)}
command -v systemctl >/dev/null 2>&1 || { ${shellPrint(t('workspace.tools.command.systemctlUnavailable'))}; exit 127; }
sb_root systemctl ${action} ${service}
`.trim()
}

export function buildToolActionCommand(tool: ToolDefinition, action: ToolAction, t: TFunction = translate) {
  if (action === 'check') return buildToolCheckCommand(tool, t)

  const actionBody = action === 'install' || action === 'upgrade' || action === 'uninstall'
    ? tool.install
      ? buildInstallRecipeCommand(tool.install, action, t)
      : `${shellPrint(t('workspace.tools.command.installRecipeUnavailable'))}; exit 127`
    : buildServiceCommand(tool, action, t)

  return `
sb_action_status=0
${actionBody} || sb_action_status=$?
printf '\\n__SB_ACTION_EXIT=%s\\n' "$sb_action_status"
printf '\\n--- %s ---\\n' ${shellQuote(t('workspace.tools.command.statusHeader'))}
${buildToolCheckCommand(tool, t)}
exit "$sb_action_status"
`.trim()
}

function parseMarker(output: string, marker: string) {
  return output.split('\n')
    .reverse()
    .find((line) => line.startsWith(`${marker}=`))
    ?.slice(marker.length + 1)
    .trim()
}

type PackageAction = 'install' | 'upgrade' | 'uninstall'

/** The action response is never evidence that a package reached its post-state. */
export async function executeVerifiedToolPackageAction(
  run: (command: string) => Promise<CommandRunResult>, tool: ToolDefinition, action: PackageAction, t: TFunction = translate,
): Promise<VerifiedDiagnosticResult> {
  if (!tool.install) throw new Error('tool_install_recipe_unavailable')
  const result = await run(buildInstallRecipeCommand(tool.install, action, t))
  if (result.exitCode !== 0) return { ...result, resultSummary: `tool=${tool.id}; action=${action}; verification=not-run; exit=${result.exitCode}` }
  let check: CommandRunResult
  try { check = await run(buildToolCheckCommand(tool, t)) } catch {
    return { ...result, exitCode: 125, errorCode: 'remote_state_unknown', errorSummary: 'The package action was sent but tool state could not be observed', resultSummary: `tool=${tool.id}; action=${action}; verification=unknown` }
  }
  const observed = parseToolStatus(check.stdout)
  const versionExit = parseMarker(check.stdout, '__SB_VERSION_EXIT')
  const unavailable = check.exitCode !== 0 || !!check.errorCode || observed.installed === null
    || (action !== 'uninstall' && observed.installed && (versionExit !== '0' || !observed.version))
  const passed = !unavailable && (action === 'uninstall' ? observed.installed === false : observed.installed === true)
  return {
    ...result, stdout: check.stdout, stderr: check.stderr, durationMs: result.durationMs + check.durationMs,
    exitCode: passed ? 0 : 125,
    resultSummary: `tool=${tool.id}; action=${action}; verification=${unavailable ? 'unknown' : passed ? 'passed' : 'failed'}; installed=${observed.installed ?? 'unknown'}; version=${action === 'uninstall' ? 'not-required' : observed.version && versionExit === '0' ? 'observed' : 'unknown'}`,
    ...(!passed ? {
      errorCode: unavailable ? 'remote_state_unknown' : 'tool_post_state_mismatch',
      errorSummary: unavailable ? 'The package action was accepted but its resulting tool state could not be observed' : 'The observed tool presence did not match the requested package action',
    } : {}),
  }
}

export function toolCommandSummary(tool: ToolDefinition, action: ToolAction) {
  if (['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) return `systemctl ${action} -- ${tool.service?.endsWith('.service') ? tool.service : `${tool.service}.service`}`
  if (tool.install?.type === 'npm') return `npm ${action === 'uninstall' ? 'uninstall' : 'install'} -g ${tool.install.packageName}${action === 'upgrade' ? '@latest' : ''}`
  if (tool.install?.type === 'pipx') return `pipx ${action} ${tool.install.packageName}`
  return `package manager ${action}: ${tool.install?.type === 'package' ? [...new Set(Object.values(tool.install.packages).flat())].filter(Boolean).join(', ') : tool.binary}`
}

export function parseToolStatus(output: string): ToolStatus {
  const installedMarker = parseMarker(output, '__SB_INSTALLED')
  const installed = installedMarker === '1' ? true : installedMarker === '0' ? false : null
  const checkedAtMs = Date.now()

  return {
    installed,
    path: parseMarker(output, '__SB_PATH') || undefined,
    version: parseMarker(output, '__SB_VERSION') || undefined,
    serviceActive: parseMarker(output, '__SB_SERVICE_ACTIVE') || undefined,
    serviceEnabled: parseMarker(output, '__SB_SERVICE_ENABLED') || undefined,
    checkedAt: new Date(checkedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    checkedAtMs,
  }
}
