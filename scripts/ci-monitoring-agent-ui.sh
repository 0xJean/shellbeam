#!/usr/bin/env bash
# A separate installed-app journey. Never reuses a real desktop profile.
set -euo pipefail
umask 077
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux && ${SHELLBEAM_OPS_UI_LIVE:-} == 1 && $EUID != 0 ]] || { echo 'Monitoring Agent UI requires opt-in ordinary-user hosted Linux'; exit 1; }
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ && ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && ${SHELLBEAM_OPS_UI_HEAD_SHA:-} =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ -d ${RUNNER_TEMP:-} && $RUNNER_TEMP == /* && ! -L $RUNNER_TEMP && $# == 1 && $1 == "$RUNNER_TEMP/shellbeam-webdriver/bin/tauri-driver" ]] || exit 1
[[ -z ${WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS:-} && -z ${WEBKIT_INSPECTOR_SERVER:-} && -z ${WEBKIT_FORCE_SANDBOX:-} ]] || exit 1
transfer_private=$(mktemp -d "$RUNNER_TEMP/shellbeam-monitoring-agent-ui-XXXXXXXX")
for transfer_dir in data config cache state runtime; do mkdir -m 700 "$transfer_private/$transfer_dir"; done
transfer_cleanup() {
  local code=$?
  trap - EXIT
  python3 - "$transfer_private/driver-pid" "$RUNNER_TEMP/shellbeam-webdriver/bin/tauri-driver" <<'PYEND'
import os,sys,signal,time,pathlib
try:
 p=pathlib.Path(sys.argv[1]); pid=int(p.read_text()); proc=pathlib.Path('/proc')/str(pid)
 if proc.stat().st_uid==os.getuid() and os.path.realpath(proc/'exe')==os.path.realpath(sys.argv[2]):
  os.killpg(pid,signal.SIGTERM); time.sleep(.5)
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
except (FileNotFoundError,ProcessLookupError): pass
PYEND
  if [[ -f $transfer_private/owner && ! -L $transfer_private/owner ]]; then
    local owner
    owner=$(cat "$transfer_private/owner")
    [[ $owner =~ ^sb-ui-transfer-[a-f0-9]{12}$ ]] || exit 1
    # Exact random ownership label; never sweep unrelated user containers.
    for suffix in a b; do
      if docker inspect "$owner-$suffix" >/dev/null 2>&1; then
        [[ $(docker inspect -f '{{index .Config.Labels "shellbeam.ui-owner"}}' "$owner-$suffix") == "$owner" ]] || exit 1
        docker rm -f "$owner-$suffix" >/dev/null || code=1
      fi
    done
    if docker network inspect "$owner-net" >/dev/null 2>&1; then
      [[ $(docker network inspect -f '{{index .Labels "shellbeam.ui-owner"}}' "$owner-net") == "$owner" ]] || exit 1
      docker network rm "$owner-net" >/dev/null || code=1
    fi
  fi
  rm -rf -- "$transfer_private"
  exit "$code"
}
trap transfer_cleanup EXIT
[[ ! -e $RUNNER_TEMP/shellbeam-monitoring-agent-ui-report.json && ! -e $RUNNER_TEMP/shellbeam-monitoring-agent-ui-artifacts ]] || exit 1
# HOME is inherited; only the private XDG profile and bus/display are replaced.
timeout --foreground --kill-after=15 1100 env -u SSH_AUTH_SOCK -u GH_TOKEN -u GITHUB_TOKEN -u DISPLAY -u XAUTHORITY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  SHELLBEAM_OPS_UI_UID="$(id -u)" SHELLBEAM_OPS_UI_FIXTURE="$transfer_private/fixture.json" \
  SHELLBEAM_MONITORING_AGENT_UI_PRIVATE="$transfer_private" SHELLBEAM_MONITORING_AGENT_UI_DRIVER="$1" \
  XDG_DATA_HOME="$transfer_private/data" XDG_CONFIG_HOME="$transfer_private/config" XDG_CACHE_HOME="$transfer_private/cache" XDG_STATE_HOME="$transfer_private/state" XDG_RUNTIME_DIR="$transfer_private/runtime" \
  TMPDIR="$transfer_private/runtime" GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  dbus-run-session --config-file=src-tauri/tests/fixtures/notifications-session.conf -- \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x900x24 -nolisten tcp' node scripts/run-monitoring-agent-ui.mjs
python3 - "$RUNNER_TEMP/shellbeam-monitoring-agent-ui-report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));assert r['success'] and r['cleanup'] and r['applicationStopped'] and r['journey']['passed']
PY
