#!/usr/bin/env bash
# Build the real, pinned upstream daemon for the disposable X11 GUI gate.
# Jammy's dunst 1.5.0 has no displayed/waiting count contract. Never substitute
# fake counts or install a notification service into the runner's user profile.
set -euo pipefail
umask 077
fail() { printf 'ShellBeam UI dunst: %s\n' "$1" >&2; exit 1; }
[[ $# == 0 && ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux && ${SHELLBEAM_OPS_UI_LIVE:-} == 1 && $(uname -s) == Linux && $EUID != 0 ]] || fail 'requires explicit disposable ordinary-user Linux acceptance'
[[ -r /etc/os-release ]] || fail 'missing Ubuntu release'
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 22.04 ]] || fail 'requires Ubuntu 22.04'
[[ ${RUNNER_TEMP:-} == /* && -d $RUNNER_TEMP && ! -L $RUNNER_TEMP ]] || fail 'requires an existing private build parent'
[[ $(realpath "$RUNNER_TEMP") == "$RUNNER_TEMP" && $(stat -c '%u' "$RUNNER_TEMP") == "$EUID" ]] || fail 'invalid build parent ownership'
for dependency in curl sha256sum tar make pkg-config install mktemp; do command -v "$dependency" >/dev/null || fail 'missing build dependency'; done

ui_dunst_commit=c8c415a8d4520d552ff3d71b9388d88044036068
ui_dunst_sha256=f2a235e16f80d290d08515280a08bde9fa64e382094f5b012b0e8b95e78807fa
ui_dunst_destination=$RUNNER_TEMP/shellbeam-ui-dunst-1.7.3
[[ ! -e $ui_dunst_destination && ! -L $ui_dunst_destination ]] || fail 'refusing an existing tool directory'
ui_dunst_scratch=$(mktemp -d "$RUNNER_TEMP/shellbeam-ui-dunst-build-XXXXXXXX")
ui_dunst_installed=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ $result != 0 && $ui_dunst_installed == 1 ]]; then
    [[ -d $ui_dunst_destination && ! -L $ui_dunst_destination && $(stat -c '%u:%a' "$ui_dunst_destination") == "$EUID:700" ]] || exit 1
    rm -rf -- "$ui_dunst_destination" || result=1
  fi
  [[ -d $ui_dunst_scratch && ! -L $ui_dunst_scratch && $(stat -c '%u:%a' "$ui_dunst_scratch") == "$EUID:700" ]] || exit 1
  rm -rf -- "$ui_dunst_scratch" || result=1
  exit "$result"
}
trap cleanup EXIT
curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --connect-timeout 10 --max-time 90 \
  --output "$ui_dunst_scratch/upstream.tar.gz" "https://codeload.github.com/dunst-project/dunst/tar.gz/$ui_dunst_commit"
[[ $(stat -c '%s' "$ui_dunst_scratch/upstream.tar.gz") -le 10485760 ]] || fail 'source archive exceeds budget'
printf '%s  %s\n' "$ui_dunst_sha256" "$ui_dunst_scratch/upstream.tar.gz" | sha256sum --check --status || fail 'upstream source checksum mismatch'
mkdir -m 700 "$ui_dunst_scratch/source" "$ui_dunst_scratch/tools"
tar --extract --gzip --file "$ui_dunst_scratch/upstream.tar.gz" --directory "$ui_dunst_scratch/source" --strip-components=1 --no-same-owner
# Build just the X11 daemon: no Wayland dependency, docs, install target, or
# D-Bus/systemd activation file. Runtime starts only our owned child explicitly.
make --no-print-directory -C "$ui_dunst_scratch/source" -j2 WAYLAND=0 SYSTEMD=0 dunst
[[ $("$ui_dunst_scratch/source/dunst" --version) == 'Dunst - A customizable and lightweight notification-daemon 1.7.3 (2021-12-08)' ]] || fail 'built daemon version mismatch'
/bin/sh -n "$ui_dunst_scratch/source/dunstctl"
install -m 755 "$ui_dunst_scratch/source/dunst" "$ui_dunst_scratch/tools/dunst"
install -m 755 "$ui_dunst_scratch/source/dunstctl" "$ui_dunst_scratch/tools/dunstctl"
mv -- "$ui_dunst_scratch/tools" "$ui_dunst_destination"
ui_dunst_installed=1
printf 'ShellBeam UI dunst: verified upstream 1.7.3, X11 only, no service installation\n'
