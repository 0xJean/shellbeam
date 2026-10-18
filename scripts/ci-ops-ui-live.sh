#!/usr/bin/env bash
# Real desktop UI acceptance ONLY on an explicitly enabled, disposable hosted
# Ubuntu runner. These guards prevent accidental use; they are not a sandbox.
# Root owns temporary SSH/systemd services. The app/driver/UI harness run as the
# existing ordinary runner user, with private XDG/DBus/X11 state and normal HOME.
set -euo pipefail
umask 077

ui_fail() { printf 'ShellBeam UI fixture: %s\n' "$1" >&2; exit 1; }

[[ ${GITHUB_ACTIONS:-} == true && ${SHELLBEAM_OPS_UI_LIVE:-} == 1 ]] || ui_fail 'requires explicit GitHub Actions UI acceptance opt-in'
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || ui_fail 'self-hosted runners and ordinary desktops are refused'
[[ ${RUNNER_OS:-} == Linux && $(uname -s) == Linux && $EUID == 0 ]] || ui_fail 'requires root on the disposable Linux runner'
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]{1,20}$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]{1,6}$ ]] || ui_fail 'requires GitHub run identity'
[[ -r /etc/os-release ]] || ui_fail 'Ubuntu release information is missing'
ui_os_id=$(awk -F= '$1 == "ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
ui_os_version=$(awk -F= '$1 == "VERSION_ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
[[ $ui_os_id == ubuntu && $ui_os_version == 22.04 ]] || ui_fail 'requires the disposable Ubuntu 22.04 runner'
[[ ${RUNNER_TEMP:-} == /* && -d ${RUNNER_TEMP:-} && ! -L ${RUNNER_TEMP:-} ]] || ui_fail 'requires an existing absolute non-symlink RUNNER_TEMP'
[[ ${SHELLBEAM_OPS_UI_UID:-} =~ ^[0-9]{1,10}$ && ${SHELLBEAM_OPS_UI_GID:-} =~ ^[0-9]{1,10}$ && ${SHELLBEAM_OPS_UI_UID:-} != 0 && ${SHELLBEAM_OPS_UI_GID:-} != 0 ]] || ui_fail 'requires the existing ordinary runner UID and GID'
[[ -z ${WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS:-} && -z ${WEBKIT_FORCE_SANDBOX:-} ]] || ui_fail 'WebKit sandbox override variables are refused'

for ui_command in sshd ssh-keygen ssh systemctl systemd-run runuser dbus-run-session xvfb-run Xvfb xauth node python3 realpath stat sha256sum getent id install timeout ps awk head sleep mktemp chmod chown rm cat mv cut basename tr; do
  command -v "$ui_command" >/dev/null 2>&1 || ui_fail "required dependency is missing: $ui_command"
done
[[ -x /usr/sbin/sshd && -d /run/sshd && ! -L /run/sshd && -d /etc/systemd/system && ! -L /etc/systemd/system ]] || ui_fail 'OpenSSH privilege separation and systemd directories must exist'
ui_user_record=$(getent passwd "$SHELLBEAM_OPS_UI_UID") || ui_fail 'runner UID does not identify an existing user'
IFS=: read -r ui_user _ ui_uid ui_gid _ ui_user_home ui_user_shell <<<"$ui_user_record"
[[ $ui_uid == "$SHELLBEAM_OPS_UI_UID" && $ui_gid == "$SHELLBEAM_OPS_UI_GID" && $(id -u "$ui_user") == "$ui_uid" && $(id -g "$ui_user") == "$ui_gid" ]] || ui_fail 'runner user identity does not match UID/GID'
[[ $ui_user_home == /* && $ui_user_shell != */nologin && $ui_user_shell != */false ]] || ui_fail 'runner must be an ordinary executable user account'
[[ $# == 2 && $1 == /* && $2 == /* && -f $1 && -x $1 && -f $2 && -x $2 ]] || ui_fail 'pass absolute executable app and driver paths'
ui_app=$(realpath "$1")
ui_driver=$(realpath "$2")
runuser -u "$ui_user" -- test -x "$ui_app" || ui_fail 'the ordinary runner cannot execute the application'
runuser -u "$ui_user" -- test -x "$ui_driver" || ui_fail 'the ordinary runner cannot execute the driver'
ui_project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f $ui_project/scripts/run-ops-ui-live.mjs && -f $ui_project/src-tauri/tests/fixtures/notifications-session.conf ]] || ui_fail 'the real UI runner or isolated DBus configuration is missing'
ui_runner_temp=$(realpath "$RUNNER_TEMP")
[[ $ui_runner_temp =~ ^/[A-Za-z0-9_./-]+$ ]] || ui_fail 'RUNNER_TEMP contains unsupported systemd/sshd path characters'
ui_report=${SHELLBEAM_OPS_UI_REPORT:-$ui_runner_temp/shellbeam-ops-ui-live-report.json}
[[ $ui_report == "$ui_runner_temp/shellbeam-ops-ui-live-report.json" && ! -e $ui_report && ! -L $ui_report ]] || ui_fail 'the UI report must be a fresh exact RUNNER_TEMP/shellbeam-ops-ui-live-report.json path'
ui_public_artifacts=${SHELLBEAM_OPS_UI_ARTIFACTS:-$ui_runner_temp/shellbeam-ops-ui-artifacts}
[[ $ui_public_artifacts == "$ui_runner_temp/shellbeam-ops-ui-artifacts" && ! -e $ui_public_artifacts && ! -L $ui_public_artifacts ]] || ui_fail 'the public UI evidence directory must be a fresh exact runner path'
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && ${SHELLBEAM_OPS_UI_HEAD_SHA:-} =~ ^[a-f0-9]{40}$ ]] || ui_fail 'requires exact checkout and PR head identities'
ui_started_ns=$(python3 -c 'import time; print(time.time_ns())')

ui_root=
ui_fixture_id=
ui_secret=
ui_desktop=
ui_runtime_root=
ui_runtime=
ui_session_unit=
ui_session_created=0
ui_units=()
ui_unit_hashes=()
ui_sshd_hashes=()
ui_cleanup_failed=0

ui_unit_owned() {
  local ui_unit=$1 ui_hash=$2 ui_path=/etc/systemd/system/$1
  [[ -f $ui_path && ! -L $ui_path && $(stat -c '%u:%a' "$ui_path") == 0:644 && $(sha256sum "$ui_path" | cut -d' ' -f1) == "$ui_hash" ]]
}

ui_show() { timeout 5 systemctl show "$1" --property="$2" --value 2>/dev/null; }

ui_unit_stopped() {
  local ui_unit=$1 ui_load ui_state ui_control
  ui_load=$(ui_show "$ui_unit" LoadState) || [[ $ui_load == not-found ]] || return 1
  if [[ $ui_load == not-found ]]; then
    ui_control=/system.slice/$ui_unit
  else
    [[ $ui_load == loaded ]] || return 1
    ui_state=$(ui_show "$ui_unit" ActiveState) || return 1
    [[ $ui_state == inactive || $ui_state == failed ]] || return 1
    ui_control=$(ui_show "$ui_unit" ControlGroup) || return 1
    [[ -n $ui_control ]] || ui_control=/system.slice/$ui_unit
  fi
  [[ $ui_control == /system.slice/"$ui_unit" ]] || return 1
  # Check the kernel's full cgroup subtree, including detached SSH sessions and
  # WebKit subprocesses. A remembered ControlGroup path need not itself be empty
  # after stopping a unit; systemd communication failure is never success.
  python3 - "$ui_control" <<'PY'
import os, sys
relative = sys.argv[1].lstrip('/')
for mount in ('/sys/fs/cgroup', '/sys/fs/cgroup/systemd'):
    root = os.path.join(mount, relative)
    if not os.path.exists(root):
        continue
    if not os.path.isdir(root) or os.path.islink(root):
        raise SystemExit(1)
    def failed(_error):
        raise SystemExit(1)
    for parent, children, files in os.walk(root, onerror=failed, followlinks=False):
        for name in ('cgroup.procs', 'tasks'):
            if name in files:
                with open(os.path.join(parent, name), encoding='ascii') as stream:
                    if stream.read().strip():
                        raise SystemExit(1)
        if 'cgroup.events' in files:
            with open(os.path.join(parent, 'cgroup.events'), encoding='ascii') as stream:
                events = dict(line.split() for line in stream)
            if events.get('populated') == '1':
                raise SystemExit(1)
PY
}

ui_report_update() {
  # The Node report describes assertions; cleanup is a separate real gate. Do
  # not follow a symlink, rewrite a pre-existing report or preserve success on
  # a failed service/process cleanup. Only fixed failure reasons are added.
  python3 - "$ui_report" "$ui_runner_temp" "$ui_uid" "$ui_gid" "$ui_started_ns" "$1" "$ui_cleanup_failed" "$2" <<'PY'
import json, os, stat, sys
path, root, uid, gid, started, result, cleanup, stage = sys.argv[1:]
if path != os.path.join(os.path.realpath(root), 'shellbeam-ops-ui-live-report.json'):
    raise SystemExit('UI report scope invalid')
try:
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    if stage == 'check':
        raise SystemExit(0)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        os.fchown(output.fileno(), int(uid), int(gid))
        os.fchmod(output.fileno(), 0o644)
        json.dump(dict(schemaVersion=1, success=False, events=[], cleanup='failed' if cleanup != '0' else 'passed', reason='ui-runner-did-not-complete'), output)
        output.write('\n')
    raise SystemExit(0)
with os.fdopen(fd, 'r+', encoding='utf-8') as output:
    info = os.fstat(output.fileno())
    current = os.stat(path, follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != int(uid) or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o644 or info.st_size > 262144
            or info.st_mtime_ns < int(started)
            or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
        raise SystemExit('UI report ownership/freshness invalid')
    report = json.load(output)
    if not isinstance(report, dict) or report.get('schemaVersion') != 1 or not isinstance(report.get('success'), bool):
        raise SystemExit('UI report schema invalid')
    if stage == 'check':
        raise SystemExit(0)
    report['cleanup'] = 'failed' if cleanup != '0' else 'passed'
    if cleanup != '0' or result != '0':
        report['success'] = False
    output.seek(0)
    json.dump(report, output, indent=2)
    output.write('\n')
    output.truncate()
    output.flush()
    os.fsync(output.fileno())
PY
}

ui_cleanup() {
  local ui_result=$? ui_index ui_unit ui_path ui_description
  trap - EXIT INT TERM
  set +e
  if [[ $ui_session_created == 1 ]]; then
    ui_description=$(ui_show "$ui_session_unit" Description)
    if [[ $ui_description == "ShellBeam disposable UI $ui_fixture_id" ]]; then
      timeout 20 systemctl stop "$ui_session_unit" >/dev/null 2>&1 || ui_cleanup_failed=1
      timeout 5 systemctl reset-failed "$ui_session_unit" >/dev/null 2>&1 || true
    elif [[ $(ui_show "$ui_session_unit" LoadState) != not-found ]]; then
      ui_cleanup_failed=1
    fi
    ui_unit_stopped "$ui_session_unit" || ui_cleanup_failed=1
  fi
  for ((ui_index=${#ui_units[@]}-1; ui_index>=0; ui_index--)); do
    ui_unit=${ui_units[$ui_index]}
    ui_path=/etc/systemd/system/$ui_unit
    if ! ui_unit_owned "$ui_unit" "${ui_unit_hashes[$ui_index]}"; then ui_cleanup_failed=1; continue; fi
    timeout 15 systemctl stop "$ui_unit" >/dev/null 2>&1 || ui_cleanup_failed=1
    timeout 5 systemctl reset-failed "$ui_unit" >/dev/null 2>&1 || true
    if ui_unit_stopped "$ui_unit"; then
      rm -- "$ui_path" || ui_cleanup_failed=1
    else ui_cleanup_failed=1; fi
  done
  if (( ${#ui_units[@]} > 0 )); then timeout 15 systemctl daemon-reload >/dev/null 2>&1 || ui_cleanup_failed=1; fi
  for ui_unit in "${ui_units[@]}"; do
    [[ $(ui_show "$ui_unit" LoadState) == not-found ]] || ui_cleanup_failed=1
  done
  ui_report_update "$ui_result" check || ui_cleanup_failed=1
  if [[ $ui_cleanup_failed == 0 ]]; then
    if [[ -n $ui_runtime_root ]]; then
      if [[ $ui_runtime_root == /run/shellbeam-ops-ui-* && -d $ui_runtime_root && ! -L $ui_runtime_root && $(stat -c '%u' "$ui_runtime_root") == 0 ]]; then
        rm -rf -- "$ui_runtime_root" || ui_cleanup_failed=1
      else ui_cleanup_failed=1; fi
    fi
    if [[ -n $ui_root ]]; then
      if [[ $ui_cleanup_failed == 0 && $ui_root == "$ui_runner_temp"/shellbeam-ops-ui-live-* && -d $ui_root && ! -L $ui_root && $(stat -c '%u:%a' "$ui_root") == 0:711 ]]; then
        rm -rf -- "$ui_root" || ui_cleanup_failed=1
      else ui_cleanup_failed=1; fi
    fi
  fi
  ui_report_update "$ui_result" finalize || ui_cleanup_failed=1
  if [[ $ui_cleanup_failed != 0 ]]; then
    printf 'ShellBeam UI fixture: cleanup failed; private state retained where possible\n' >&2
    [[ $ui_result != 0 ]] || ui_result=1
  fi
  exit "$ui_result"
}
trap ui_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ui_root=$(python3 - "$ui_runner_temp" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" <<'PY'
import os, secrets, sys
root, run, attempt = sys.argv[1:]
for _ in range(100):
    path = os.path.join(root, f'shellbeam-ops-ui-live-{run}-{attempt}-{secrets.token_hex(4)}')
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        continue
    print(path)
    break
else:
    raise SystemExit('could not allocate private UI fixture')
PY
)
chmod 711 "$ui_root"
ui_fixture_id=$(basename "$ui_root" | tr '[:upper:]' '[:lower:]')
ui_secret=$ui_root/root
ui_desktop=$ui_root/desktop
ui_session_unit=shellbeam-ui-session-${ui_fixture_id#shellbeam-ops-ui-live-}.service
install -d -m 700 "$ui_secret"
install -d -m 700 -o "$ui_uid" -g "$ui_gid" "$ui_desktop"
ui_runtime_root=$(mktemp -d /run/shellbeam-ops-ui-XXXXXXXX)
chmod 711 "$ui_runtime_root"
ui_runtime=$ui_runtime_root/session
install -d -m 700 "$ui_runtime_root/auth"
install -d -m 700 -o "$ui_uid" -g "$ui_gid" "$ui_runtime"
for ui_directory in keys data config cache state artifacts; do install -d -m 700 -o "$ui_uid" -g "$ui_gid" "$ui_desktop/$ui_directory"; done
ui_bus_config=$ui_desktop/session-bus.conf
python3 - "$ui_project/src-tauri/tests/fixtures/notifications-session.conf" "$ui_bus_config" "$ui_runtime" <<'PY'
import sys
source, destination, runtime = sys.argv[1:]
with open(source, encoding='utf-8') as stream:
    text = stream.read()
if text.count('<listen>unix:tmpdir=/tmp</listen>') != 1 or '<standard_session_servicedirs' in text or '<servicedir>' in text:
    raise SystemExit('isolated DBus configuration invalid')
with open(destination, 'x', encoding='utf-8') as stream:
    stream.write(text.replace('<listen>unix:tmpdir=/tmp</listen>', f'<listen>unix:tmpdir={runtime}</listen>'))
PY
chown "$ui_uid:$ui_gid" "$ui_bus_config"
chmod 600 "$ui_bus_config"

# Three separate host/client pairs. Only fixture-generated public keys are
# authorized, under a root-owned /run ancestor chain for StrictModes=yes.
read -r ui_jump_port ui_direct_port ui_via_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(3)]
try:
    for sock in sockets:
        sock.bind(('127.0.0.1', 0))
    print(*(sock.getsockname()[1] for sock in sockets))
finally:
    for sock in sockets:
        sock.close()
PY
)
for ui_port in "$ui_jump_port" "$ui_direct_port" "$ui_via_port"; do
  [[ $ui_port =~ ^[0-9]+$ && $ui_port -gt 1024 && $ui_port -le 65535 ]] || ui_fail 'could not allocate independent loopback SSH ports'
done
ui_observer_hosts=$ui_desktop/observer-known-hosts
: >"$ui_observer_hosts"
for ui_role in jump direct via; do
  install -d -m 700 "$ui_secret/$ui_role" "$ui_runtime_root/auth/$ui_role"
  ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f "$ui_secret/$ui_role/host" >/dev/null
  ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f "$ui_secret/$ui_role/client" >/dev/null
  install -m 600 "$ui_secret/$ui_role/client.pub" "$ui_runtime_root/auth/$ui_role/authorized_keys"
  install -m 600 -o "$ui_uid" -g "$ui_gid" "$ui_secret/$ui_role/client" "$ui_desktop/keys/$ui_role.pem"
  install -m 600 -o "$ui_uid" -g "$ui_gid" "$ui_secret/$ui_role/host.pub" "$ui_desktop/keys/$ui_role-host.pub"
  case $ui_role in jump) ui_port=$ui_jump_port ;; direct) ui_port=$ui_direct_port ;; via) ui_port=$ui_via_port ;; esac
  printf '[127.0.0.1]:%s ' "$ui_port" >>"$ui_observer_hosts"
  cat "$ui_secret/$ui_role/host.pub" >>"$ui_observer_hosts"
  cat >"$ui_secret/$ui_role/sshd_config" <<EOF
Port $ui_port
ListenAddress 127.0.0.1
HostKey $ui_secret/$ui_role/host
PidFile $ui_secret/$ui_role/sshd.pid
AuthorizedKeysFile $ui_runtime_root/auth/$ui_role/authorized_keys
AllowUsers root
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PubkeyAcceptedAlgorithms +ssh-rsa
HostKeyAlgorithms +ssh-rsa
LogLevel ERROR
Subsystem sftp internal-sftp
EOF
  if [[ $ui_role == jump ]]; then
    printf 'AllowTcpForwarding local\nPermitOpen 127.0.0.1:%s\n' "$ui_via_port" >>"$ui_secret/$ui_role/sshd_config"
  else printf 'AllowTcpForwarding no\n' >>"$ui_secret/$ui_role/sshd_config"; fi
  /usr/sbin/sshd -t -f "$ui_secret/$ui_role/sshd_config" || ui_fail 'private SSH server configuration is invalid'
done
chown "$ui_uid:$ui_gid" "$ui_observer_hosts"
chmod 600 "$ui_observer_hosts"

ui_write_unit() {
  local ui_unit=$1 ui_source=$2 ui_path=/etc/systemd/system/$1
  [[ ! -e $ui_path && ! -L $ui_path && $(ui_show "$ui_unit" LoadState) == not-found ]] || ui_fail 'temporary systemd unit name collision'
  install -m 644 "$ui_source" "$ui_path"
  ui_units+=("$ui_unit")
  ui_unit_hashes+=("$(sha256sum "$ui_path" | cut -d' ' -f1)")
}

# Each target's service starts once during setup and really fails. Its next
# start can only come from an explicitly confirmed UI restart. Counting lives
# in a root-private path, so independent SSH observations cannot mutate it.
install -d -m 700 "$ui_secret/services"
cat >"$ui_secret/services/run-service.sh" <<'SH'
#!/bin/sh
set -eu
service_state=$1
service_role=$2
read -r service_starts <"$service_state/start-count"
case $service_starts in ''|*[!0-9]*) exit 78 ;; esac
service_starts=$((service_starts + 1))
printf '%s\n' "$service_starts" >"$service_state/start-count.next"
mv -- "$service_state/start-count.next" "$service_state/start-count"
if [ -f "$service_state/fail-once" ]; then
  rm -- "$service_state/fail-once"
  printf 'SHELLBEAM_UI_FAILED_SERVICE %s\n' "$service_role" >&2
  exit 42
fi
printf 'SHELLBEAM_UI_RECOVERED_SERVICE %s\n' "$service_role"
exec /usr/bin/sleep infinity
SH
chmod 700 "$ui_secret/services/run-service.sh"
ui_unit_suffix=${ui_fixture_id#shellbeam-ops-ui-live-}
ui_direct_service=00-shellbeam-ui-$ui_unit_suffix-direct.service
ui_via_service=00-shellbeam-ui-$ui_unit_suffix-via.service
for ui_role in direct via; do
  install -d -m 700 "$ui_secret/services/$ui_role"
  printf '0\n' >"$ui_secret/services/$ui_role/start-count"
  : >"$ui_secret/services/$ui_role/fail-once"
  ui_unit=00-shellbeam-ui-$ui_unit_suffix-$ui_role.service
  cat >"$ui_secret/services/$ui_role/unit" <<EOF
[Unit]
Description=ShellBeam disposable UI failure $ui_fixture_id $ui_role
StartLimitIntervalSec=0
[Service]
Type=exec
ExecStart=/bin/sh $ui_secret/services/run-service.sh $ui_secret/services/$ui_role $ui_role
Restart=no
KillMode=control-group
TimeoutStopSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
  ui_write_unit "$ui_unit" "$ui_secret/services/$ui_role/unit"
done
for ui_role in jump direct via; do
  ui_unit=shellbeam-ui-ssh-$ui_unit_suffix-$ui_role.service
  cat >"$ui_secret/$ui_role/unit" <<EOF
[Unit]
Description=ShellBeam disposable UI SSH $ui_fixture_id $ui_role
[Service]
Type=exec
ExecStart=/usr/sbin/sshd -D -e -f $ui_secret/$ui_role/sshd_config
Restart=no
KillMode=control-group
TimeoutStopSec=5
EOF
  ui_write_unit "$ui_unit" "$ui_secret/$ui_role/unit"
  ui_sshd_hashes+=("$(sha256sum "/etc/systemd/system/$ui_unit" | cut -d' ' -f1)")
done
timeout 15 systemctl daemon-reload
for ui_role in direct via; do
  ui_unit=00-shellbeam-ui-$ui_unit_suffix-$ui_role.service
  timeout 15 systemctl start "$ui_unit" >/dev/null 2>&1 || true
  ui_failed=0
  for _ in {1..50}; do
    if [[ $(ui_show "$ui_unit" ActiveState) == failed ]]; then ui_failed=1; break; fi
    sleep 0.1
  done
  [[ $ui_failed == 1 && $(ui_show "$ui_unit" ExecMainStatus) == 42 && $(cat "$ui_secret/services/$ui_role/start-count") == 1 && ! -e $ui_secret/services/$ui_role/fail-once ]] || ui_fail 'the owned service did not enter its real initial failure'
done
timeout 10 systemctl list-units --type=service --all --no-pager --plain --no-legend >"$ui_secret/all-services"
head -n 40 "$ui_secret/all-services" >"$ui_secret/first-40-services"
for ui_unit in "$ui_direct_service" "$ui_via_service"; do
  awk -v unit="$ui_unit" '$1 == unit { found=1 } END { exit !found }' "$ui_secret/first-40-services" || ui_fail 'owned failed service is absent from the product first-40 service list'
done
for ui_role in jump direct via; do timeout 15 systemctl start "shellbeam-ui-ssh-$ui_unit_suffix-$ui_role.service"; done
python3 - "$ui_jump_port" "$ui_direct_port" "$ui_via_port" <<'PY'
import socket, sys, time
for value in sys.argv[1:]:
    deadline = time.monotonic() + 5
    while True:
        try:
            with socket.create_connection(('127.0.0.1', int(value)), timeout=1) as stream:
                stream.settimeout(1)
                if not stream.recv(256).startswith(b'SSH-2.0-'):
                    raise RuntimeError('unexpected SSH banner')
            break
        except (OSError, RuntimeError):
            if time.monotonic() >= deadline:
                raise SystemExit('real SSH fixture did not become ready')
            time.sleep(.1)
PY

ui_manifest=$ui_desktop/fixture.json
python3 - "$ui_manifest" "$ui_root" "$ui_desktop" "$ui_runtime" "$ui_fixture_id" "$ui_app" "$ui_driver" "$ui_report" "$ui_observer_hosts" "$ui_jump_port" "$ui_direct_port" "$ui_via_port" "$ui_direct_service" "$ui_via_service" "${ui_sshd_hashes[@]}" <<'PY'
import base64, hashlib, json, os, sys
path, root, desktop, runtime, fixture, app, driver, report, known, jump, direct, via, direct_unit, via_unit, jump_sha, direct_sha, via_sha = sys.argv[1:]
hosts = {}
for role, port, service, ssh_sha in [('jump', jump, None, jump_sha), ('direct', direct, direct_unit, direct_sha), ('via', via, via_unit, via_sha)]:
    public_path = os.path.join(desktop, 'keys', role + '-host.pub')
    with open(public_path, encoding='ascii') as stream:
        key = stream.read().split()
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(key[1], validate=True)).digest()).decode('ascii')
    hosts[role] = dict(name='ShellBeam UI ' + role + ' ' + fixture, address='127.0.0.1', port=int(port), user='root',
        privateKeyPath=os.path.join(desktop, 'keys', role + '.pem'), expectedFingerprint=fingerprint,
        hostPublicKeyPath=public_path, observerKnownHostsPath=known, serviceUnit=service,
        sshdUnit='shellbeam-ui-ssh-' + fixture.removeprefix('shellbeam-ops-ui-live-') + '-' + role + '.service', sshdUnitSha256=ssh_sha,
        serviceStartCountPath=os.path.join(root, 'root', 'services', role, 'start-count') if service else None,
        initialServiceStartCount=1 if service else None)
hosts['via']['jumpHostName'] = hosts['jump']['name']
payload = dict(schemaVersion=1, fixtureId=fixture, sharedKernel=True, rootFixtureDir=root, desktopDir=desktop,
    artifactDir=os.path.join(desktop, 'artifacts'), appPath=app, driverPath=driver, reportPath=report,
    observerKnownHostsPath=known, hosts=hosts,
    xdgPaths=dict(data=os.path.join(desktop, 'data'), config=os.path.join(desktop, 'config'), cache=os.path.join(desktop, 'cache'), state=os.path.join(desktop, 'state'), runtime=runtime))
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
    json.dump(payload, stream)
    stream.write('\n')
PY
chown "$ui_uid:$ui_gid" "$ui_manifest"
chmod 600 "$ui_manifest"

[[ $(ui_show "$ui_session_unit" LoadState) == not-found ]] || ui_fail 'temporary desktop session name collision'
ui_session_created=1
cd -- "$ui_project"
# runuser supplies the normal target-user environment; HOME is never overridden.
# Private DBus has no service autoactivation. xvfb-run alone supplies DISPLAY and
# XAUTHORITY. The actual WebKit sandbox remains enabled, under an ordinary UID.
timeout --foreground --kill-after=15 960 systemd-run --quiet --wait --pipe --collect --service-type=exec --unit="$ui_session_unit" \
  --description="ShellBeam disposable UI $ui_fixture_id" \
  --property=KillMode=control-group --property=TimeoutStopSec=10 --property=RuntimeMaxSec=900 \
  --property="WorkingDirectory=$ui_project" \
  runuser -u "$ui_user" -- env -u SSH_AUTH_SOCK -u SSH_AGENT_PID -u GH_TOKEN -u GITHUB_TOKEN \
    -u DISPLAY -u XAUTHORITY -u DBUS_SESSION_BUS_ADDRESS -u WAYLAND_DISPLAY \
    -u WEBKIT_INSPECTOR_SERVER -u WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS -u WEBKIT_FORCE_SANDBOX \
    PATH="$PATH" GITHUB_ACTIONS=true GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" \
    GITHUB_SHA="$GITHUB_SHA" SHELLBEAM_OPS_UI_HEAD_SHA="$SHELLBEAM_OPS_UI_HEAD_SHA" RUNNER_ENVIRONMENT=github-hosted RUNNER_OS=Linux RUNNER_TEMP="$ui_runner_temp" \
    SHELLBEAM_OPS_UI_LIVE=1 SHELLBEAM_OPS_UI_UID="$ui_uid" SHELLBEAM_OPS_UI_GID="$ui_gid" \
    SHELLBEAM_OPS_UI_FIXTURE="$ui_manifest" SHELLBEAM_OPS_UI_REPORT="$ui_report" SHELLBEAM_OPS_UI_ARTIFACTS="$ui_public_artifacts" \
    XDG_DATA_HOME="$ui_desktop/data" XDG_CONFIG_HOME="$ui_desktop/config" XDG_CACHE_HOME="$ui_desktop/cache" XDG_STATE_HOME="$ui_desktop/state" XDG_RUNTIME_DIR="$ui_runtime" \
    TMPDIR="$ui_runtime" GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session --config-file="$ui_bus_config" -- \
    xvfb-run --auto-servernum --error-file="$ui_desktop/xvfb-error.log" --server-args='-screen 0 1280x900x24 -nolisten tcp' \
    node "$ui_project/scripts/run-ops-ui-live.mjs"
# A successful process exit without an actual successful assertion report must
# not turn into a passing shell gate. Cleanup still records its separate result.
ui_report_update 0 check
python3 - "$ui_report" <<'PY'
import json, os, sys
with os.fdopen(os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), encoding='utf-8') as stream:
    if json.load(stream).get('success') is not True:
        raise SystemExit('UI acceptance did not complete successfully')
PY
# Successful UI acceptance must have really restarted each owned service once.
for ui_role in direct via; do
  [[ $(cat "$ui_secret/services/$ui_role/start-count") == 2 && $(ui_show "00-shellbeam-ui-$ui_unit_suffix-$ui_role.service" ActiveState) == active ]] || ui_fail 'UI did not produce exactly one verified restart per target'
done
