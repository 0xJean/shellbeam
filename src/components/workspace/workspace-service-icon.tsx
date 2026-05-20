import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Database, Globe, Layers3, Server, Shield, SquareTerminal, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const SIMPLE_ICONS_BASE_URL = 'https://cdn.simpleicons.org'

const SERVICE_ICON_SLUGS: Record<string, string> = {
  apache: 'apache',
  nginx: 'nginx',
  apache2: 'apache',
  httpd: 'apache',
  caddy: 'caddy',
  haproxy: 'haproxy',
  traefik: 'traefikproxy',
  certbot: 'letsencrypt',
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
  containerd: 'containerd',
  podman: 'podman',
  kubernetes: 'kubernetes',
  kubectl: 'kubernetes',
  helm: 'helm',
  k3s: 'k3s',
  node: 'nodedotjs',
  npm: 'npm',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun',
  deno: 'deno',
  php: 'php',
  'php-fpm': 'php',
  python: 'python',
  python3: 'python',
  pip: 'pypi',
  pipx: 'python',
  ruby: 'ruby',
  gem: 'rubygems',
  go: 'go',
  rust: 'rust',
  java: 'openjdk',
  maven: 'apachemaven',
  gradle: 'gradle',
  composer: 'composer',
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
  pm2: 'pm2',
  systemd: 'systemd',
  supervisor: 'python',
  cron: 'linux',
  logrotate: 'linux',
  ufw: 'ubuntu',
  firewalld: 'redhat',
  fail2ban: 'linux',
  openssl: 'openssl',
  nmap: 'nmap',
  tcpdump: 'linux',
  netcat: 'linux',
  wireguard: 'wireguard',
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'googlegemini',
  aider: 'aider',
  ollama: 'ollama',
  'langchain-cli': 'langchain',
}

const SERVICE_FALLBACK_ICONS: Array<[RegExp, LucideIcon]> = [
  [/nginx|apache|caddy|haproxy|traefik|certbot/i, Globe],
  [/mysql|mariadb|postgres|sqlite|mongodb|redis|memcached|rabbitmq|kafka|clickhouse/i, Database],
  [/docker|containerd|podman|k3s|kubectl|helm/i, Layers3],
  [/systemd|supervisor|pm2|cron|logrotate/i, SquareTerminal],
  [/ufw|firewalld|fail2ban|wireguard|openssl|nmap|tcpdump/i, Shield],
  [/node|npm|pnpm|yarn|bun|deno|python|pip|ruby|gem|go|rust|java|maven|gradle|php|composer/i, Wrench],
]

function getServiceIconSlug(name: string) {
  const normalized = name.trim().toLowerCase().replace(/\.service$/, '')
  return SERVICE_ICON_SLUGS[normalized]
}

function getServiceFallbackIcon(name: string) {
  return SERVICE_FALLBACK_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? Server
}

export function getServiceIconConfig(name: string) {
  const slug = getServiceIconSlug(name)
  const FallbackIcon = getServiceFallbackIcon(name)
  return { slug, FallbackIcon }
}

interface WorkspaceServiceIconProps {
  name: string
  slug?: string
  className?: string
}

export function WorkspaceServiceIcon({ name, slug: overrideSlug, className }: WorkspaceServiceIconProps) {
  const [failed, setFailed] = useState(false)
  const { slug, FallbackIcon } = useMemo(() => {
    const config = getServiceIconConfig(name)
    return { ...config, slug: overrideSlug ?? config.slug }
  }, [name, overrideSlug])

  useEffect(() => {
    setFailed(false)
  }, [name, slug, overrideSlug])

  if (slug && !failed) {
    return (
      <img
        src={`${SIMPLE_ICONS_BASE_URL}/${slug}`}
        alt=""
        className={cn('h-4 w-4 shrink-0 object-contain', className)}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    )
  }

  return <FallbackIcon className={cn('h-4 w-4 shrink-0', className)} />
}
