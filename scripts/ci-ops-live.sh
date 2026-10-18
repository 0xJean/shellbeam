#!/usr/bin/env bash
# Destructive fixture setup ONLY for an explicitly enabled, disposable GitHub-hosted
# Ubuntu runner. These guards prevent accidental local/self-hosted execution;
# they are not a security sandbox for untrusted workflow code.
# Usage (root, with the documented runner environment preserved):
#   SHELLBEAM_OPS_LIVE=1 bash scripts/ci-ops-live.sh /absolute/path/to/native-bridge
set -euo pipefail
umask 077

fail() { printf 'ShellBeam live fixture: %s\n' "$1" >&2; exit 1; }

[[ ${GITHUB_ACTIONS:-} == true ]] || fail 'requires GITHUB_ACTIONS=true'
[[ ${SHELLBEAM_OPS_LIVE:-} == 1 ]] || fail 'requires explicit SHELLBEAM_OPS_LIVE=1'
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || fail 'requires a disposable github-hosted runner; self-hosted runners are refused'
[[ ${RUNNER_OS:-} == Linux && $(uname -s) == Linux ]] || fail 'requires a Linux runner'
[[ $EUID == 0 ]] || fail 'must run as root on the disposable runner'
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]{1,20}$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]{1,6}$ ]] || fail 'requires GitHub run identity'
[[ ${RUNNER_TEMP:-} == /* && -d ${RUNNER_TEMP:-} && ! -L ${RUNNER_TEMP:-} ]] || fail 'requires an existing non-symlink absolute RUNNER_TEMP'
[[ -r /etc/os-release ]] || fail 'Ubuntu release information is missing'
ops_os_id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
[[ $ops_os_id == ubuntu ]] || fail 'only disposable Ubuntu runners are supported'

for ops_command in docker nginx openssl sshd busybox systemctl curl node python3 file dpkg-query sha256sum install realpath setsid timeout cmp stat getent; do
  command -v "$ops_command" >/dev/null 2>&1 || fail "required dependency is missing: $ops_command"
done
[[ $(dpkg-query -W -f='${Status}' busybox-static 2>/dev/null) == 'install ok installed' ]] || fail 'busybox-static must be installed'
ops_busybox=$(command -v busybox)
ops_busybox_type=$(file -Lb "$ops_busybox")
[[ $ops_busybox_type == *'statically linked'* || $ops_busybox_type == *'static-pie linked'* ]] || fail 'busybox must be the real statically linked binary'
timeout 15 docker info >/dev/null || fail 'Docker must already be running; this script never starts it'
nginx -v >/dev/null 2>&1 || fail 'Nginx is unavailable'
openssl version >/dev/null || fail 'OpenSSL is unavailable'
[[ $(systemctl show nginx.service --property=LoadState --value) == loaded ]] || fail 'the real nginx systemd service must be installed'
ops_original_nginx_state=$(systemctl show nginx.service --property=ActiveState --value)
[[ $ops_original_nginx_state == active || $ops_original_nginx_state == inactive ]] || fail 'nginx must start in a stable active/inactive state'
[[ -f /etc/nginx/nginx.conf && ! -L /etc/nginx/nginx.conf ]] || fail 'nginx.conf must be a regular file'
[[ -d /etc/nginx/conf.d && -d /etc/ssl/certs && -d /var/www ]] || fail 'required Nginx/TLS directories are missing'
getent passwd www-data >/dev/null || fail 'the Nginx worker user is missing'
[[ $# == 1 && $1 == /* && -f $1 && -x $1 ]] || fail 'pass one absolute executable native bridge path'
ops_bridge=$(realpath "$1")
ops_project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f $ops_project/scripts/run-ops-live.mjs ]] || fail 'the production-adapter live runner is missing'
ops_runner_temp=$(realpath "$RUNNER_TEMP")
ops_report_path=${SHELLBEAM_OPS_LIVE_REPORT:-$ops_runner_temp/shellbeam-ops-live-report.json}
[[ $ops_report_path == "$ops_runner_temp/shellbeam-ops-live-report.json" && ! -e $ops_report_path && ! -L $ops_report_path ]] || fail 'report must be a fresh exact RUNNER_TEMP/shellbeam-ops-live-report.json path'
ops_report_started_ns=$(python3 -c 'import time; print(time.time_ns())')
export SHELLBEAM_OPS_LIVE_REPORT=$ops_report_path

ops_fixture_dir=$(mktemp -d "$ops_runner_temp/shellbeam-ops-live-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-XXXXXXXX")
chmod 700 "$ops_fixture_dir"
ops_fixture_id=$(basename "$ops_fixture_dir" | tr '[:upper:]' '[:lower:]')
ops_container_name=$ops_fixture_id
ops_image_tag=$ops_fixture_id:fixture
ops_cert_path=/etc/ssl/certs/$ops_fixture_id.pem
ops_site_path=/etc/nginx/conf.d/$ops_fixture_id.conf
ops_document_root=/var/www/$ops_fixture_id
ops_fixture_json=$ops_fixture_dir/fixture.json
ops_original_nginx_hash=$(sha256sum /etc/nginx/nginx.conf | cut -d' ' -f1)
ops_nginx_touched=0
ops_site_created=0
ops_cert_created=0
ops_document_root_created=0
ops_docker_touched=0
ops_node_pgid=
ops_cleanup_failed=0

cleanup() {
  local ops_result=$?
  trap - EXIT INT TERM
  set +e
  # The Node runner and its bridge are started in their own process group. Stop
  # that group before restoring services or deleting private fixture state.
  if [[ -n $ops_node_pgid ]] && kill -0 -- "-$ops_node_pgid" 2>/dev/null; then
    kill -TERM -- "-$ops_node_pgid" 2>/dev/null
    for _ in {1..100}; do
      kill -0 -- "-$ops_node_pgid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$ops_node_pgid" 2>/dev/null
    wait "$ops_node_pgid" 2>/dev/null
  fi
  if [[ $ops_nginx_touched == 1 ]]; then
    systemctl stop nginx.service >/dev/null 2>&1 || ops_cleanup_failed=1
    if [[ $ops_site_created == 1 ]]; then rm -f -- "$ops_site_path" || ops_cleanup_failed=1; fi
    cp --preserve=all -- "$ops_fixture_dir/nginx.conf.original" /etc/nginx/nginx.conf || ops_cleanup_failed=1
    [[ $(sha256sum /etc/nginx/nginx.conf | cut -d' ' -f1) == "$ops_original_nginx_hash" ]] || ops_cleanup_failed=1
    if [[ $ops_original_nginx_state == active ]]; then
      nginx -t >"$ops_fixture_dir/nginx-restore.log" 2>&1 && systemctl start nginx.service >/dev/null 2>&1 || ops_cleanup_failed=1
      systemctl is-active --quiet nginx.service || ops_cleanup_failed=1
    else
      [[ $(systemctl show nginx.service --property=ActiveState --value) == inactive ]] || ops_cleanup_failed=1
    fi
  elif [[ $ops_site_created == 1 ]]; then
    rm -f -- "$ops_site_path" || ops_cleanup_failed=1
  fi
  if [[ $ops_docker_touched == 1 ]]; then
    if [[ $(docker container inspect --format '{{index .Config.Labels "app.shellbeam.ops-live"}}' "$ops_container_name" 2>/dev/null) == "$ops_fixture_id" ]]; then
      docker container rm --force "$ops_container_name" >/dev/null 2>&1 || ops_cleanup_failed=1
    fi
    if [[ $(docker image inspect --format '{{index .Config.Labels "app.shellbeam.ops-live"}}' "$ops_image_tag" 2>/dev/null) == "$ops_fixture_id" ]]; then
      docker image rm "$ops_image_tag" >/dev/null 2>&1 || ops_cleanup_failed=1
    fi
  fi
  if [[ $ops_cert_created == 1 ]]; then rm -f -- "$ops_cert_path" || ops_cleanup_failed=1; fi
  if [[ $ops_document_root_created == 1 ]]; then rm -rf -- "$ops_document_root" || ops_cleanup_failed=1; fi
  if [[ $ops_fixture_dir == "$ops_runner_temp"/shellbeam-ops-live-* && -d $ops_fixture_dir && ! -L $ops_fixture_dir ]]; then
    rm -rf -- "$ops_fixture_dir" || ops_cleanup_failed=1
  else
    ops_cleanup_failed=1
  fi
  # The public summary must include cleanup, not merely the Node assertions.
  # Never follow a symlink or rewrite an unrelated/stale runner file as root.
  if ! python3 - "$ops_report_path" "$ops_runner_temp" "$ops_report_started_ns" "$ops_cleanup_failed" "$ops_result" <<'PY'
import json, os, stat, sys
path, runner, started, cleanup_failed, result = sys.argv[1:]
if path != os.path.join(os.path.realpath(runner), 'shellbeam-ops-live-report.json'):
    raise SystemExit('live report scope invalid')
try:
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    raise SystemExit(0)  # Setup/Node may fail before creating any summary.
with os.fdopen(descriptor, 'r+', encoding='utf-8') as stream:
    info = os.fstat(stream.fileno())
    current = os.stat(path, follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or info.st_mode & 0o022 or info.st_size > 262144
            or info.st_mtime_ns < int(started)
            or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
        raise SystemExit('live report ownership/freshness invalid')
    summary = json.load(stream)
    if not isinstance(summary, dict) or summary.get('schemaVersion') != 1 or not isinstance(summary.get('success'), bool):
        raise SystemExit('live report schema invalid')
    summary['cleanup'] = 'failed' if cleanup_failed != '0' else 'passed'
    if cleanup_failed != '0' or result != '0':
        summary['success'] = False
    stream.seek(0)
    json.dump(summary, stream, indent=2)
    stream.write('\n')
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())
PY
  then
    ops_cleanup_failed=1
  fi
  if [[ $ops_cleanup_failed != 0 ]]; then
    printf 'ShellBeam live fixture: resource/service cleanup failed\n' >&2
    if [[ $ops_result == 0 ]]; then ops_result=1; fi
  fi
  exit "$ops_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp --preserve=all -- /etc/nginx/nginx.conf "$ops_fixture_dir/nginx.conf.original"
[[ ! -e $ops_site_path && ! -L $ops_site_path && ! -e $ops_cert_path && ! -L $ops_cert_path && ! -e $ops_document_root && ! -L $ops_document_root ]] || fail 'fixture resource name collision'
ops_site_name=$ops_fixture_id.test
ops_second_domain=www.$ops_site_name
ops_expected_body=$ops_fixture_id-ready
ops_log_marker=SHELLBEAM_OPS_LIVE_CONTAINER_READY

# Allocate two distinct kernel-selected loopback ports. Nginx startup still fails
# if a competing process acquires one after these temporary reservations close.
read -r ops_http_port ops_https_port < <(python3 - <<'PY'
import socket
listeners = [socket.socket(), socket.socket()]
try:
    for listener in listeners:
        listener.bind(('127.0.0.1', 0))
    print(*(listener.getsockname()[1] for listener in listeners))
finally:
    for listener in listeners:
        listener.close()
PY
)
[[ $ops_http_port =~ ^[0-9]+$ && $ops_https_port =~ ^[0-9]+$ && $ops_http_port -gt 1024 && $ops_https_port -gt 1024 ]] || fail 'loopback port allocation failed'

mkdir "$ops_fixture_dir/image"
cp -- "$ops_busybox" "$ops_fixture_dir/image/busybox"
chmod 755 "$ops_fixture_dir/image/busybox"
cat >"$ops_fixture_dir/image/Dockerfile" <<EOF
FROM scratch
LABEL app.shellbeam.ops-live="$ops_fixture_id"
COPY busybox /busybox
USER 65534:65534
CMD ["/busybox", "sh", "-c", "echo $ops_log_marker; exec /busybox sleep 3600"]
EOF
ops_docker_touched=1
timeout 90 docker build --network=none --pull=false --quiet --iidfile "$ops_fixture_dir/image-id" --tag "$ops_image_tag" "$ops_fixture_dir/image" >"$ops_fixture_dir/docker-build.log" 2>&1 || fail 'local FROM scratch fixture build failed'
ops_image_id=$(cat "$ops_fixture_dir/image-id")
[[ $ops_image_id =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Docker did not return an immutable image identity'
ops_container_id=$(timeout 30 docker run --pull=never --detach --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 32m --name "$ops_container_name" --label "app.shellbeam.ops-live=$ops_fixture_id" "$ops_image_tag")
[[ $ops_container_id =~ ^[a-f0-9]{64}$ ]] || fail 'Docker did not return an immutable container identity'
[[ $(docker inspect --format '{{.Image}}' "$ops_container_id") == "$ops_image_id" ]] || fail 'container image identity does not match the local build'
[[ $(docker inspect --format '{{.State.Running}}' "$ops_container_id") == true ]] || fail 'fixture container exited before observation'
ops_container_ready=0
for _ in {1..50}; do
  if [[ $(docker logs --tail 1 "$ops_container_id" 2>/dev/null) == "$ops_log_marker" ]]; then ops_container_ready=1; break; fi
  sleep 0.1
done
[[ $ops_container_ready == 1 ]] || fail 'fixture container did not emit its real readiness marker'

# This self-signed CA is an explicit trust anchor only for this curl request.
# Never import it into the runner/user OS trust store and never disable TLS checks.
(set -o noclobber; : >"$ops_cert_path") || fail 'certificate path already exists'
ops_cert_created=1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$ops_fixture_dir/tls-private-key.pem" -out "$ops_cert_path" \
  -subj "/CN=$ops_site_name" \
  -addext "subjectAltName=DNS:$ops_site_name,DNS:$ops_second_domain" \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign' \
  -addext 'extendedKeyUsage=serverAuth' >"$ops_fixture_dir/openssl.log" 2>&1 || fail 'real SAN certificate generation failed'
chmod 600 "$ops_fixture_dir/tls-private-key.pem"
chmod 644 "$ops_cert_path"
openssl verify -CAfile "$ops_cert_path" "$ops_cert_path" >/dev/null || fail 'fixture trust anchor is invalid'
mkdir -m 755 "$ops_document_root"
ops_document_root_created=1
printf '%s\n' "$ops_expected_body" >"$ops_document_root/index.html"
chmod 644 "$ops_document_root/index.html"
(set -o noclobber; : >"$ops_site_path") || fail 'site configuration path already exists'
ops_site_created=1
cat >"$ops_site_path" <<EOF
server {
    listen 127.0.0.1:$ops_http_port;
    listen 127.0.0.1:$ops_https_port ssl;
    server_name $ops_site_name $ops_second_domain;
    root $ops_document_root;
    ssl_certificate $ops_cert_path;
    ssl_certificate_key $ops_fixture_dir/tls-private-key.pem;
    location / {
        try_files \$uri /index.html;
    }
}
EOF
chmod 644 "$ops_site_path"
cat >"$ops_fixture_dir/nginx-fixture.conf" <<EOF
user www-data;
worker_processes 1;
pid /run/nginx.pid;
error_log $ops_fixture_dir/nginx-error.log;
events { worker_connections 64; }
http {
    server_names_hash_bucket_size 128;
    access_log $ops_fixture_dir/nginx-access.log;
    include /etc/nginx/mime.types;
    include $ops_site_path;
}
EOF
ops_nginx_touched=1
systemctl stop nginx.service
install -m 644 "$ops_fixture_dir/nginx-fixture.conf" /etc/nginx/nginx.conf
nginx -t >"$ops_fixture_dir/nginx-test.log" 2>&1 || fail 'real Nginx fixture configuration is invalid'
systemctl start nginx.service
systemctl is-active --quiet nginx.service || fail 'real Nginx did not become active'
for ops_domain in "$ops_site_name" "$ops_second_domain"; do
  ops_response=$(curl -q --noproxy '*' --proto '=https' --fail --silent --show-error --max-time 8 \
    --cacert "$ops_cert_path" --resolve "$ops_domain:$ops_https_port:127.0.0.1" "https://$ops_domain:$ops_https_port/") || fail 'independent verified HTTPS request failed'
  [[ $ops_response == "$ops_expected_body" ]] || fail 'independent HTTPS content did not match this fixture'
done

python3 - "$ops_fixture_json" "$ops_fixture_dir" "$ops_fixture_id" "$ops_container_id" "$ops_image_id" "$ops_site_name" "$ops_cert_path" "$ops_http_port" "$ops_https_port" "$ops_site_path" "$ops_document_root" "$ops_expected_body" "$ops_log_marker" <<'PY'
import json, os, sys
path, root, fixture, container, image, domain, certificate, http, https, site, docroot, expected, marker = sys.argv[1:]
payload = dict(schemaVersion=1, fixtureId=fixture, rootFixtureDir=root,
    containerId=container, containerName=fixture, imageId=image, imageTag=fixture+':fixture',
    siteName=domain, domains=[domain, 'www.'+domain], certificatePath=certificate,
    caCertPath=certificate, httpPort=int(http), httpsPort=int(https),
    nginxSiteConfigPath=site, documentRoot=docroot, expectedBody=expected, logMarker=marker)
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
    json.dump(payload, stream)
    stream.write('\n')
PY
[[ $(stat -c '%a' "$ops_fixture_json") == 600 ]] || fail 'fixture metadata permissions must be 0600'
export SHELLBEAM_OPS_LIVE_BRIDGE=$ops_bridge
export SHELLBEAM_OPS_LIVE_FIXTURE_FILE=$ops_fixture_json
cd -- "$ops_project"
setsid node scripts/run-ops-live.mjs "$ops_fixture_json" &
ops_node_pgid=$!
ops_node_result=0
wait "$ops_node_pgid" || ops_node_result=$?
exit "$ops_node_result"
