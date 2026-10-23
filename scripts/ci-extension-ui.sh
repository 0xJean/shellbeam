#!/usr/bin/env bash
# A separate installed-app journey. Never reuses a real desktop profile.
set -euo pipefail
umask 077
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux && ${SHELLBEAM_OPS_UI_LIVE:-} == 1 && $EUID != 0 ]] || { echo 'Extension UI requires opt-in ordinary-user hosted Linux'; exit 1; }
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ && ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && ${SHELLBEAM_OPS_UI_HEAD_SHA:-} =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ -d ${RUNNER_TEMP:-} && $RUNNER_TEMP == /* && ! -L $RUNNER_TEMP && $# == 1 && $1 == "$RUNNER_TEMP/shellbeam-webdriver/bin/tauri-driver" ]] || exit 1
[[ -z ${WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS:-} && -z ${WEBKIT_INSPECTOR_SERVER:-} && -z ${WEBKIT_FORCE_SANDBOX:-} ]] || exit 1
extension_private=$(mktemp -d "$RUNNER_TEMP/shellbeam-extension-ui-XXXXXXXX")
for extension_dir in data config cache state runtime; do mkdir -m 700 "$extension_private/$extension_dir"; done
extension_cleanup() {
  local code=$?
  trap - EXIT
  python3 - "$extension_private/driver-pid" "$RUNNER_TEMP/shellbeam-webdriver/bin/tauri-driver" <<'PYEND'
import os,sys,signal,time,pathlib
try:
 p=pathlib.Path(sys.argv[1]); pid=int(p.read_text()); proc=pathlib.Path('/proc')/str(pid)
 if proc.stat().st_uid==os.getuid() and os.path.realpath(proc/'exe')==os.path.realpath(sys.argv[2]):
  os.killpg(pid,signal.SIGTERM); time.sleep(.5)
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
except (FileNotFoundError,ProcessLookupError): pass
PYEND
  python3 - "$extension_private" <<'PYEND'
import pathlib,os,signal,time,sys
root=pathlib.Path(sys.argv[1]); binary=root/'official-komari'
for role in ['fresh','legacy']:
 try:
  pid=int((root/(role+'-pid')).read_text()); proc=pathlib.Path('/proc')/str(pid)
  if proc.stat().st_uid==os.getuid() and os.path.realpath(proc/'exe')==str(binary):
   os.kill(pid,signal.SIGTERM);time.sleep(.5)
   try: os.kill(pid,signal.SIGKILL)
   except ProcessLookupError: pass
 except (FileNotFoundError,ProcessLookupError): pass
PYEND
  rm -rf -- "$extension_private"
  exit "$code"
}
trap extension_cleanup EXIT
[[ ! -e $RUNNER_TEMP/shellbeam-extension-ui-report.json && ! -e $RUNNER_TEMP/shellbeam-extension-ui-artifacts ]] || exit 1
# HOME is inherited; only the private XDG profile and bus/display are replaced.
timeout --foreground --kill-after=15 1100 env -u SSH_AUTH_SOCK -u GH_TOKEN -u GITHUB_TOKEN -u DISPLAY -u XAUTHORITY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  SHELLBEAM_OPS_UI_UID="$(id -u)" SHELLBEAM_OPS_UI_FIXTURE="$extension_private/fixture.json" \
  SHELLBEAM_EXTENSION_UI_PRIVATE="$extension_private" SHELLBEAM_EXTENSION_UI_DRIVER="$1" \
  XDG_DATA_HOME="$extension_private/data" XDG_CONFIG_HOME="$extension_private/config" XDG_CACHE_HOME="$extension_private/cache" XDG_STATE_HOME="$extension_private/state" XDG_RUNTIME_DIR="$extension_private/runtime" \
  TMPDIR="$extension_private/runtime" GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  dbus-run-session --config-file=src-tauri/tests/fixtures/notifications-session.conf -- \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x900x24 -nolisten tcp' node scripts/run-extension-ui.mjs
python3 - "$RUNNER_TEMP/shellbeam-extension-ui-report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));assert r['success'] and r['cleanup'] and r['applicationStopped'] and r['journey']['passed']
PY
