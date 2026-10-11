LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL PATH
[ "$(uname -s)" = Linux ] || { printf 'Linux is required\n' >&2; exit 2; }
printf '__SB_MCP_BEGIN\n'
cpu_before=$(awk '/^cpu / {for (i=2;i<=9;i++) total+=$i; print total,$5+$6; exit}' /proc/stat 2>/dev/null)
net_before=$(awk 'NR>2 {gsub(/:/," "); if ($1!="lo") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
time_before=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)
sleep 1
cpu_after=$(awk '/^cpu / {for (i=2;i<=9;i++) total+=$i; print total,$5+$6; exit}' /proc/stat 2>/dev/null)
net_after=$(awk 'NR>2 {gsub(/:/," "); if ($1!="lo") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
time_after=$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)
printf '%s\n%s\n' "$cpu_before" "$cpu_after" | awk 'NR==1 {total=$1; idle=$2} NR==2 && $1>total {printf "__SB_MCP_CPU=%.2f\n", 100*(($1-total)-($2-idle))/($1-total)}'
printf '%s\n%s\n' "$net_before" "$net_after" | awk -v start="$time_before" -v end="$time_after" 'NR==1 {rx=$1; tx=$2} NR==2 && end>start {printf "__SB_MCP_NETWORK=%.0f %.0f\n",($1-rx)/(end-start),($2-tx)/(end-start)}'
printf '__SB_MCP_ARCH=%s\n' "$(uname -m)"
printf '__SB_MCP_KERNEL=%s\n' "$(uname -sr)"
printf '__SB_MCP_CORES=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"
printf '__SB_MCP_HOSTNAME=%s\n' "$(hostname 2>/dev/null)"
printf '__SB_MCP_OS=%s\n' "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1)"
printf '__SB_MCP_UPTIME=%s\n' "$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)"
printf '__SB_MCP_LOAD=%s\n' "$(cat /proc/loadavg 2>/dev/null)"
awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {printf "__SB_MCP_MEM=%s %s\n", $1, $2}' /proc/meminfo 2>/dev/null
df -Pk 2>/dev/null | head -n 101 | sed 's/^/__SB_MCP_DISK=/'
df -Pi 2>/dev/null | head -n 101 | sed 's/^/__SB_MCP_INODE=/'
ss -H -lntu 2>/dev/null | head -n 200 | sed 's/^/__SB_MCP_PORT=/'
for tool in docker podman node npm pnpm bun python3 go java nginx caddy git systemctl; do
  location=$(command -v "$tool" 2>/dev/null)
  [ -z "$location" ] || printf '__SB_MCP_TOOL=%s %s\n' "$tool" "$location"
done
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}},"ports":{{json .Ports}}}' 2>/dev/null | head -n 100 | sed 's/^/__SB_MCP_CONTAINER=/'
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n 200 | sed 's/^/__SB_MCP_SERVICE=/'
fi
for root in /srv /opt /var/www /home; do
  [ ! -d "$root" ] || find "$root" -maxdepth 3 -type f \( -name package.json -o -name compose.yml -o -name compose.yaml -o -name docker-compose.yml -o -name docker-compose.yaml -o -name go.mod -o -name pyproject.toml -o -name Cargo.toml \) 2>/dev/null
done | head -n 100 | sed 's/^/__SB_MCP_PROJECT=/'
printf '__SB_MCP_END\n'
