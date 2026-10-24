#!/bin/sh
# Explicitly authorized CI smoke only; never overwrite a developer's install/history.
set -eu
[ "${SHELLBEAM_AGENT_ALLOW_SERVICE_SMOKE:-}" = 1 ] || { echo 'Set SHELLBEAM_AGENT_ALLOW_SERVICE_SMOKE=1 in an isolated CI account.' >&2; exit 2; }
[ "$(uname -s)" = Linux ] || { echo 'This service smoke requires Linux user systemd.' >&2; exit 2; }
source_binary="$(pwd)/agent/target/debug/shellbeam-agent"
target_binary="$HOME/.local/bin/shellbeam-agent"
agent_data="$HOME/.local/share/shellbeam-agent"
agent_unit="$HOME/.config/systemd/user/shellbeam-agent.service"
[ ! -e "$target_binary" ] && [ ! -e "$agent_data" ] && [ ! -e "$agent_unit" ] || { echo 'Refusing to modify an existing agent installation.' >&2; exit 2; }
cleanup() { "$source_binary" uninstall --json --path "$target_binary" --purge >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$HOME/.local/bin"
cp "$source_binary" "$target_binary"
chmod 0755 "$target_binary"
"$target_binary" install --json --path "$target_binary" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["health"]=="online"; assert v["metrics"]["memoryTotalBytes"]>0; assert "inventory" in v'
"$target_binary" service status --json | python3 -c 'import json,sys; assert json.load(sys.stdin)["health"]=="online"'
"$target_binary" upgrade --json --path "$target_binary" | python3 -c 'import json,sys; assert json.load(sys.stdin)["health"]=="online"'
"$target_binary" history --json --limit 10 | python3 -c 'import json,sys; assert len(json.load(sys.stdin))>=2'
"$target_binary" uninstall --json --path "$target_binary" --purge | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="retired"'
[ ! -e "$target_binary" ] && [ ! -e "$agent_data" ] && [ ! -e "$agent_unit" ]
trap - EXIT HUP INT TERM
echo 'User service install, new heartbeat, upgrade, history and verified uninstall passed.'
