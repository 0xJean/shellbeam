#!/usr/bin/env bash
# Install the shared acceptance package, run one suite, and always remove it.
set -euo pipefail
[[ $# -ge 1 && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || { echo 'usage on a hosted runner: ci-with-installed-package.sh command [args...]'; exit 1; }
test ! -e /usr/bin/shellbeam-ops-ui-acceptance
mapfile -t ui_packages < <(find "$RUNNER_TEMP/shellbeam-acceptance-package" -maxdepth 1 -type f -name '*.deb')
test "${#ui_packages[@]}" = 1
ui_package="${ui_packages[0]}"
ui_package_name="$(dpkg-deb --field "$ui_package" Package)"
test "$ui_package_name" = shell-beam
if dpkg-query -W "$ui_package_name" >/dev/null 2>&1; then exit 1; fi
cleanup_package() {
  local ui_exit=$?
  trap - EXIT
  sudo dpkg --remove "$ui_package_name" || ui_exit=1
  test ! -e /usr/bin/shellbeam-ops-ui-acceptance || ui_exit=1
  exit "$ui_exit"
}
trap cleanup_package EXIT
sudo dpkg --install "$ui_package"
test -x /usr/bin/shellbeam-ops-ui-acceptance
"$@"
