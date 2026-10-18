# Shared Linux read-only collector template; rendered from collection-limits.json
# by Desktop and native MCP. Remote hosts do not need a config/JSON parser.
sb_clean() { tr '\n|' '  ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c 1-180; }
sb_run() {
  if command -v timeout >/dev/null 2>&1; then timeout __SB_LIMIT_optionalCommandTimeoutSeconds__ "$@"; else
    "$@" & sb_child=$!
    (sleep __SB_LIMIT_optionalCommandTimeoutSeconds__; kill "$sb_child" 2>/dev/null) & sb_watch=$!
    wait "$sb_child"; sb_result=$?
    kill "$sb_watch" 2>/dev/null; wait "$sb_watch" 2>/dev/null
    return "$sb_result"
  fi
}
LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin:${PATH}
export LC_ALL PATH
SB_PROBE_STARTED=$(date +%s)
SB_PROBE_OS=$(uname -s)
[ "$SB_PROBE_OS" = Linux ] || { printf '__SB_PROBE_UNSUPPORTED_OS=%s\n' "$SB_PROBE_OS"; printf 'PROBE_UNSUPPORTED_OS: %s\n' "$SB_PROBE_OS" >&2; exit 2; }
printf '__SB_PROBE_BEGIN\n__SB_PROBE_SCHEMA=1\n'
printf '__SB_PROBE_SAMPLED_AT=%s000\n' "$(date +%s)"
cpu_before=$(awk '/^cpu / {for (i=2;i<=9;i++) total+=$i; print total,$5+$6; exit}' /proc/stat 2>/dev/null)
net_before=$(awk 'NR>2 {gsub(/:/," "); if ($1!="lo") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
time_before=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)
sleep 1
cpu_after=$(awk '/^cpu / {for (i=2;i<=9;i++) total+=$i; print total,$5+$6; exit}' /proc/stat 2>/dev/null)
net_after=$(awk 'NR>2 {gsub(/:/," "); if ($1!="lo") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
time_after=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)
printf '%s\n%s\n' "$cpu_before" "$cpu_after" | awk 'NR==1 {total=$1; idle=$2} NR==2 && $1>total {printf "__SB_PROBE_CPU=%.2f\n", 100*(($1-total)-($2-idle))/($1-total)}'
printf '%s\n%s\n' "$net_before" "$net_after" | awk -v start="$time_before" -v end="$time_after" 'NR==1 {rx=$1; tx=$2} NR==2 && end>start {printf "__SB_PROBE_NETWORK=%.0f %.0f\n",($1-rx)/(end-start),($2-tx)/(end-start)}'
printf '__SB_PROBE_ARCH=%s\n' "$(uname -m)"
printf '__SB_PROBE_KERNEL=%s\n' "$(uname -sr)"
printf '__SB_PROBE_CORES=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"
printf '__SB_PROBE_HOSTNAME=%s\n' "$(hostname 2>/dev/null)"
printf '__SB_PROBE_OS=%s\n' "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1)"
printf '__SB_PROBE_UPTIME=%s\n' "$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)"
printf '__SB_PROBE_LOAD=%s\n' "$(cat /proc/loadavg 2>/dev/null)"
awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {printf "__SB_PROBE_MEM=%s %s\n", $1, $2}' /proc/meminfo 2>/dev/null
df -Pk 2>/dev/null | head -n $((__SB_LIMIT_filesystemRows__ + 1)) | cut -c 1-1024 | sed 's/^/__SB_PROBE_DISK=/'
df -Pi 2>/dev/null | head -n $((__SB_LIMIT_filesystemRows__ + 1)) | cut -c 1-1024 | sed 's/^/__SB_PROBE_INODE=/'
if [ "${1:-all}" != metrics ]; then
ss -H -lntu 2>/dev/null | head -n __SB_LIMIT_portRows__ | cut -c 1-240 | sed 's/^/__SB_PROBE_PORT=/'
if command -v systemctl >/dev/null 2>&1; then
  sb_run systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n __SB_LIMIT_serviceRows__ | cut -c 1-240 | sed 's/^/__SB_PROBE_SERVICE=/'
fi
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
  version_value=""
  if [ "$(( $(date +%s) - SB_PROBE_STARTED ))" -lt __SB_LIMIT_versionBudgetSeconds__ ]; then version_value="$(sb_run "$found" --version 2>&1 | head -n 1 | sb_clean)"; fi
  printf '__SB_PROBE_TOOLDETAIL=%s|%s|%s|%s|%s|%s\n' "$tool_id" "$tool_name" "$category" "$found" "$path_value" "$version_value"
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
      printf '__SB_PROBE_SERVICEDETAIL=%s|%s|%s\n' "$service" "$active_value" "$enabled_value"
    fi
  done
fi

if command -v docker >/dev/null 2>&1; then
  sb_run docker ps -a --format '__SB_PROBE_DOCKERDETAIL={{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.ID}}' 2>/dev/null | head -n __SB_LIMIT_containerRows__ | cut -c 1-1024
fi

if [ -r "$HOME/.pm2/dump.pm2" ]; then
  printf '__SB_PROBE_PM2=PM2 saved process definitions present (live state unknown)\n'
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

sb_json_project_name() {
  if command -v python3 >/dev/null 2>&1; then
    head -c __SB_LIMIT_manifestReadBytes__ "$1" | python3 -I -c 'import json,sys
try:
 value=json.loads(sys.stdin.read(__SB_LIMIT_manifestReadBytes__)).get("name")
 if isinstance(value,str): sys.stdout.write(value[:180])
except (ValueError,AttributeError): pass' 2>/dev/null | sb_clean
  else
    head -c __SB_LIMIT_manifestReadBytes__ "$1" | sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^" ]*\)".*/\1/p' 2>/dev/null | head -n 1 | sb_clean
  fi
}

sb_project_name() {
  marker="$1"
  project_root="$2"
  marker_name="$(basename "$marker")"
  manifest_name=""
  case "$marker_name" in
    package.json|composer.json)
      manifest_name="$(sb_json_project_name "$marker")"
      ;;
    pyproject.toml)
      manifest_name="$(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$marker" 2>/dev/null | head -n 1 | sb_clean)"
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
    find "$root" -maxdepth __SB_LIMIT_projectDepth__ -type f \( -name package.json -o -name docker-compose.yml -o -name docker-compose.yaml -o -name compose.yml -o -name compose.yaml -o -name go.mod -o -name pyproject.toml -o -name requirements.txt -o -name composer.json -o -name Cargo.toml \) 2>/dev/null | head -n __SB_LIMIT_projectRowsPerRoot__
  fi
done | head -n __SB_LIMIT_projectManifestRows__ | while IFS= read -r marker; do
  project_dir="$(sb_project_root "$(dirname "$marker")")"
  marker_name="$(basename "$marker")"
  project_kind="$(sb_project_kind "$marker_name")"
  project_name="$(sb_project_name "$marker" "$project_dir")"
  modified_at="$(date -r "$marker" '+%Y-%m-%d %H:%M' 2>/dev/null || stat -c '%y' "$marker" 2>/dev/null | cut -d. -f1 | cut -c 1-16)"
  printf '__SB_PROBE_PROJECTDETAIL=%s|%s|%s|%s|%s\n' "$project_dir" "$project_kind" "$project_name" "$modified_at" "$marker"
done

fi
printf '__SB_PROBE_END\n'
