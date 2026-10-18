#!/usr/bin/env bash
# Source-only extension of ci-ops-live.sh. Never run on a workstation or a
# self-hosted runner. The opt-in checks prevent mistakes, not hostile workflow
# code. No OS trust store, public DNS or public ACME service is used.

_ops_acme_error() { printf 'ShellBeam ACME fixture: %s\n' "$1" >&2; return 1; }

_ops_acme_guard() {
  [[ ${GITHUB_ACTIONS:-} == true && ${SHELLBEAM_OPS_LIVE:-} == 1 ]] || { _ops_acme_error 'requires explicit GitHub live Ops opt-in'; return 1; }
  [[ ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux && $EUID == 0 ]] || { _ops_acme_error 'requires a disposable GitHub-hosted Linux root runner'; return 1; }
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { _ops_acme_error 'pinned fixture requires Linux x86_64'; return 1; }
  [[ ${RUNNER_TEMP:-} == /* && -d $RUNNER_TEMP && ! -L $RUNNER_TEMP ]] || { _ops_acme_error 'RUNNER_TEMP is invalid'; return 1; }
  [[ -r /etc/os-release ]] || { _ops_acme_error 'Ubuntu release metadata is missing'; return 1; }
  [[ $(awk -F= '$1=="ID" {gsub(/"/,"",$2); print $2}' /etc/os-release) == ubuntu && $(awk -F= '$1=="VERSION_ID" {gsub(/"/,"",$2); print $2}' /etc/os-release) == 22.04 ]] || { _ops_acme_error 'pinned CPython 3.10 wheels require Ubuntu 22.04'; return 1; }
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  _ops_acme_error 'must be sourced by the guarded live Ops fixture'
  exit 1
fi
_ops_acme_guard || return 1

ops_acme_dir=''
ops_acme_dir_owned=0
ops_acme_dns_pgid=''
ops_acme_pebble_pgid=''
ops_acme_letsencrypt_owned=0
ops_acme_certbot_owned=0
ops_acme_timers_before=''
ops_acme_metadata_json=''
ops_acme_transport_ca=''
ops_acme_issuer_ca=''
ops_acme_managed_certificate_path=''

_ops_acme_timers() {
  local timer load enabled active
  for timer in certbot.timer snap.certbot.renew.timer; do
    load=$(systemctl show "$timer" --property=LoadState --value 2>/dev/null || true)
    enabled=$(systemctl is-enabled "$timer" 2>/dev/null || true)
    active=$(systemctl is-active "$timer" 2>/dev/null || true)
    printf '%s|%s|%s|%s\n' "$timer" "$load" "$enabled" "$active"
  done
}

_ops_acme_fetch() {
  local url=$1 digest=$2 destination=$3
  curl -q --noproxy '*' --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --max-redirs 3 \
    --connect-timeout 10 --max-time 60 --retry 2 --max-filesize 33554432 \
    --output "$destination" "$url" || return 1
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status || { _ops_acme_error 'pinned artifact SHA-256 mismatch'; return 1; }
}

_ops_acme_unpack() {
  # Extract one pinned regular binary, never paths supplied by an archive.
  python3 - "$1" "$2" "$3" <<'PY'
import os, sys, tarfile
archive, member, destination = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as source:
    matches = [item for item in source.getmembers() if item.name == member]
    if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size <= 67108864:
        raise SystemExit('pinned ACME archive layout invalid')
    content = source.extractfile(matches[0])
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700), 'wb') as output:
        output.write(content.read(67108865))
PY
}

_ops_acme_stop_group() {
  local process_group=$1
  [[ -n $process_group ]] || return 0
  if kill -0 -- "-$process_group" 2>/dev/null; then
    kill -TERM -- "-$process_group" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 -- "-$process_group" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 -- "-$process_group" 2>/dev/null; then
      kill -KILL -- "-$process_group" 2>/dev/null || return 1
    fi
  fi
  wait "$process_group" 2>/dev/null || true
  ! kill -0 -- "-$process_group" 2>/dev/null
}

ops_acme_cleanup() {
  # Called by the parent's EXIT trap after stopping Node/native SSH, before it
  # restores nginx. Never delete any default path without proving ownership.
  local result=0
  [[ -n $ops_acme_dir && $ops_acme_dir_owned == 1 ]] || return 0
  _ops_acme_guard || return 1
  _ops_acme_stop_group "$ops_acme_pebble_pgid" || result=1
  _ops_acme_stop_group "$ops_acme_dns_pgid" || result=1
  ops_acme_pebble_pgid=''
  ops_acme_dns_pgid=''
  if [[ $ops_acme_certbot_owned == 1 ]]; then
    if [[ -L /usr/local/bin/certbot && $(readlink /usr/local/bin/certbot) == "$ops_acme_dir/venv/bin/certbot" ]]; then
      rm -- /usr/local/bin/certbot || result=1
    else
      result=1
    fi
  fi
  if [[ $ops_acme_letsencrypt_owned == 1 ]]; then
    if [[ -L /etc/letsencrypt && $(readlink /etc/letsencrypt) == "$ops_acme_dir/letsencrypt" ]]; then
      rm -- /etc/letsencrypt || result=1
    else
      result=1
    fi
  fi
  if [[ -n $ops_acme_timers_before && $(_ops_acme_timers) != "$ops_acme_timers_before" ]]; then
    _ops_acme_error 'existing Certbot timer state changed; not changing it again'
    result=1
  fi
  # Parent owns deletion of rootFixtureDir. Keep the private tree on a failed
  # owned-path check, so another process is never redirected to removed state.
  if [[ $result == 0 && $ops_acme_dir == "$ops_fixture_dir/acme" && -d $ops_acme_dir && ! -L $ops_acme_dir ]]; then
    rm -rf -- "$ops_acme_dir" || result=1
  fi
  return "$result"
}

ops_acme_setup() {
  _ops_acme_guard || return 1
  [[ -z $ops_acme_dir ]] || { _ops_acme_error 'setup may only run once'; return 1; }
  for ops_acme_command in python3 openssl curl sha256sum setsid timeout systemctl nginx install realpath readlink; do
    command -v "$ops_acme_command" >/dev/null 2>&1 || { _ops_acme_error "missing dependency: $ops_acme_command"; return 1; }
  done
  python3 -c 'import sys; assert sys.version_info[:2] == (3, 10)' || { _ops_acme_error 'requires CPython 3.10 for the pinned native wheels'; return 1; }
  python3 - "${ops_fixture_dir:-}" "${ops_fixture_id:-}" "${ops_site_name:-}" "${ops_second_domain:-}" "${ops_document_root:-}" "${ops_http_port:-}" "${ops_https_port:-}" "${ops_site_path:-}" "$RUNNER_TEMP" <<'PY'
import os, re, stat, sys
root, identity, domain, second, webroot, http, https, site, runner = sys.argv[1:]
info = os.stat(root, follow_symlinks=False)
if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077
        or os.path.realpath(root) != root or os.path.dirname(root) != os.path.realpath(runner)
        or not re.fullmatch(r'shellbeam-ops-live-[a-zA-Z0-9-]+', os.path.basename(root))
        or identity != os.path.basename(root).lower()
        or domain != identity + '.test' or second != 'www.' + domain
        or webroot != '/var/www/' + identity or site != '/etc/nginx/conf.d/' + identity + '.conf'
        or not http.isdigit() or not https.isdigit()
        or not 1024 < int(http) <= 65535 or not 1024 < int(https) <= 65535
        or http == https):
    raise SystemExit('ACME fixture scope invalid')
for path, directory in [(webroot, True), (site, False)]:
    row = os.stat(path, follow_symlinks=False)
    if row.st_uid != 0 or (stat.S_ISDIR(row.st_mode) if directory else stat.S_ISREG(row.st_mode)) is False:
        raise SystemExit('ACME site ownership invalid')
PY
  [[ $? == 0 ]] || return 1
  [[ ! -e /etc/letsencrypt && ! -L /etc/letsencrypt && ! -e /usr/local/bin/certbot && ! -L /usr/local/bin/certbot ]] || { _ops_acme_error 'refusing to replace existing Certbot configuration or executable'; return 1; }
  ops_acme_timers_before=$(_ops_acme_timers)
  if printf '%s\n' "$ops_acme_timers_before" | awk -F'|' '$3 ~ /^(enabled|linked)/ || $4 == "active" || $4 == "activating" { found=1 } END { exit !found }'; then
    _ops_acme_error 'existing Certbot timer is enabled or active; refusing fixture setup'
    return 1
  fi
  ops_acme_dir="$ops_fixture_dir/acme"
  mkdir -m 700 "$ops_acme_dir" || return 1
  ops_acme_dir_owned=1
  mkdir -m 700 "$ops_acme_dir/downloads" "$ops_acme_dir/bin" "$ops_acme_dir/letsencrypt" "$ops_acme_dir/work" "$ops_acme_dir/logs" || return 1
  ops_acme_transport_ca="$ops_acme_dir/transport-ca.pem"
  ops_acme_issuer_ca="$ops_acme_dir/issuer-root.pem"
  ops_acme_managed_certificate_path="/etc/letsencrypt/live/$ops_fixture_id/fullchain.pem"
  ops_acme_metadata_json="$ops_acme_dir/metadata.json"
  export ops_acme_transport_ca ops_acme_issuer_ca ops_acme_managed_certificate_path ops_acme_metadata_json

  # Official v2.10.1 release, commit b1e1ca4f3c30abb64111adaca4544bc5374cc306.
  _ops_acme_fetch 'https://github.com/letsencrypt/pebble/releases/download/v2.10.1/pebble-linux-amd64.tar.gz' \
    '4f2fcb5bca8c85c9cf73ad140fccfc0d2be40bd81ab99879c79b7b8a0b4f70ed' "$ops_acme_dir/downloads/pebble.tar.gz" || return 1
  _ops_acme_fetch 'https://github.com/letsencrypt/pebble/releases/download/v2.10.1/pebble-challtestsrv-linux-amd64.tar.gz' \
    'e93a5aa25ecdf3af2f9fbb2de32b0173e64a2eae81002a4ccfe35fa6f4f60b92' "$ops_acme_dir/downloads/dns.tar.gz" || return 1
  _ops_acme_unpack "$ops_acme_dir/downloads/pebble.tar.gz" pebble-linux-amd64/linux/amd64/pebble "$ops_acme_dir/bin/pebble" || return 1
  _ops_acme_unpack "$ops_acme_dir/downloads/dns.tar.gz" pebble-challtestsrv-linux-amd64/linux/amd64/pebble-challtestsrv "$ops_acme_dir/bin/pebble-challtestsrv" || return 1

  # Complete Linux/CPython 3.10 lock: every wheel is pinned to an official PyPI
  # SHA-256; no source build, global pip install or implicit extra dependency.
  cat >"$ops_acme_dir/requirements.txt" <<'REQ'
acme==5.8.0 --hash=sha256:637501767248156545d85c23b806381ac346c5eac759f8e35052af85b7bb3933
certbot==5.8.0 --hash=sha256:c06793e6a0169b07ee09e11e6a017c7d5a77310055d693fffd66c53363ab87ff
certifi==2026.7.22 --hash=sha256:62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775
cffi==2.1.1 --hash=sha256:194cffa889098ced9976c3fc6340305e43f6303657d298da55366907c05c22d6
charset-normalizer==3.5.2 --hash=sha256:8a893cc101149f80a653f82062ebc95b34525a2614382e1da5458fe7c6997249
ConfigArgParse==1.8.0 --hash=sha256:bb25b307c3cd46a3e868e7f7aa51487eb8003a9f01cac3ae129b66ec26eb794c
configobj==5.0.9 --hash=sha256:1ba10c5b6ee16229c79a05047aeda2b55eb4e80d7c7d8ecf17ec1ca600c79882
cryptography==50.0.2 --hash=sha256:1981f1db4630889b9ef7803fadef12b056f428cb6b85c27ba57b774793b6093c
distro==1.9.0 --hash=sha256:7bffd925d65168f85027d8da9af6bddab658135b840670a223589bc0c8ef02b2
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
josepy==2.2.0 --hash=sha256:63e9dd116d4078778c25ca88f880cc5d95f1cab0099bebe3a34c2e299f65d10b
parsedatetime==2.6 --hash=sha256:cb96edd7016872f58479e35879294258c71437195760746faffedb692aef000b
pycparser==3.11 --hash=sha256:51d5a8ba2be0bbe440b99d2112604c95bbbc3c2748a64260186c541e1729cd80
pyOpenSSL==26.4.0 --hash=sha256:f0eb0cb2d581d3ad2b9c489468485e7f2ab6727d08401bcf9d824c3caddf3c1c
pyRFC3339==2.1.0 --hash=sha256:560f3f972e339f579513fe1396974352fd575ef27caff160a38b312252fcddf3
requests==2.34.2 --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
typing_extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
urllib3==2.8.0 --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
REQ
  python3 -m venv "$ops_acme_dir/venv" || return 1
  timeout 240 "$ops_acme_dir/venv/bin/python" -m pip --isolated install \
    --disable-pip-version-check --no-cache-dir --index-url https://pypi.org/simple \
    --only-binary=:all: --require-hashes -r "$ops_acme_dir/requirements.txt" >"$ops_acme_dir/pip.log" 2>&1 || { _ops_acme_error 'pinned Certbot dependency installation failed'; return 1; }
  "$ops_acme_dir/venv/bin/python" -m pip check >"$ops_acme_dir/pip-check.log" 2>&1 || return 1
  [[ $("$ops_acme_dir/venv/bin/certbot" --version) == 'certbot 5.8.0' ]] || { _ops_acme_error 'installed Certbot version mismatch'; return 1; }

  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
    -keyout "$ops_acme_dir/transport-ca.key" -out "$ops_acme_transport_ca" \
    -subj '/CN=ShellBeam CI ACME transport CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' >"$ops_acme_dir/transport-ca.log" 2>&1 || return 1
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$ops_acme_dir/server.key" -out "$ops_acme_dir/server.csr" \
    -subj '/CN=localhost' >"$ops_acme_dir/server-csr.log" 2>&1 || return 1
  cat >"$ops_acme_dir/server.extensions" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
  openssl x509 -req -in "$ops_acme_dir/server.csr" -CA "$ops_acme_transport_ca" \
    -CAkey "$ops_acme_dir/transport-ca.key" -CAcreateserial -days 2 -sha256 \
    -extfile "$ops_acme_dir/server.extensions" -out "$ops_acme_dir/server.pem" >"$ops_acme_dir/server-sign.log" 2>&1 || return 1
  openssl verify -CAfile "$ops_acme_transport_ca" -verify_hostname localhost "$ops_acme_dir/server.pem" >"$ops_acme_dir/server-verify.log" 2>&1 || return 1

  local ports acme_port management_port dns_port dns_management_port
  ports=$(python3 - <<'PY'
import socket
listeners = [socket.socket() for _ in range(4)]
try:
    for item in listeners:
        item.bind(('127.0.0.1', 0))
    print(*(item.getsockname()[1] for item in listeners))
finally:
    for item in listeners:
        item.close()
PY
  ) || return 1
  read -r acme_port management_port dns_port dns_management_port <<<"$ports"
  local directory_url="https://localhost:$acme_port/dir"
  python3 - "$ops_acme_dir" "$acme_port" "$management_port" "$ops_http_port" "$ops_https_port" <<'PY'
import json, os, sys
root, acme, management, http, https = sys.argv[1:]
value = {'pebble': dict(listenAddress='127.0.0.1:'+acme, managementListenAddress='127.0.0.1:'+management,
    certificate=root+'/server.pem', privateKey=root+'/server.key', httpPort=int(http), tlsPort=int(https),
    ocspResponderURL='', externalAccountBindingRequired=False, domainBlocklist=[],
    retryAfter={'authz':1,'order':1}, keyAlgorithm='ecdsa',
    profiles={'default': {'description':'Disposable local ACME acceptance only','validityPeriod':7776000}})}
with open(root+'/pebble.json','x') as target:
    json.dump(value,target)
PY
  [[ $? == 0 ]] || return 1
  setsid "$ops_acme_dir/bin/pebble-challtestsrv" \
    -dnsserver "127.0.0.1:$dns_port" -management "127.0.0.1:$dns_management_port" \
    -defaultIPv4 127.0.0.1 -defaultIPv6 '' -http01 '' -https01 '' -tlsalpn01 '' \
    >"$ops_acme_dir/dns.log" 2>&1 &
  ops_acme_dns_pgid=$!
  setsid env -u PEBBLE_VA_ALWAYS_VALID -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    PEBBLE_VA_NOSLEEP=1 PEBBLE_AUTHZREUSE=0 PEBBLE_WFE_NONCEREJECT=0 NO_PROXY='*' \
    "$ops_acme_dir/bin/pebble" -strict=false -config "$ops_acme_dir/pebble.json" -dnsserver "127.0.0.1:$dns_port" \
    >"$ops_acme_dir/pebble.log" 2>&1 &
  ops_acme_pebble_pgid=$!
  local ready=0
  for _ in {1..40}; do
    kill -0 "$ops_acme_dns_pgid" 2>/dev/null && kill -0 "$ops_acme_pebble_pgid" 2>/dev/null || { _ops_acme_error 'local DNS/ACME process exited before readiness'; return 1; }
    if curl -q --noproxy '*' --fail --silent --show-error --max-time 2 --cacert "$ops_acme_transport_ca" "$directory_url" >"$ops_acme_dir/directory.json" 2>/dev/null \
      && curl -q --noproxy '*' --fail --silent --max-time 2 -X POST -H 'Content-Type: application/json' --data '{"ip":"127.0.0.1"}' "http://127.0.0.1:$dns_management_port/set-default-ipv4" >/dev/null; then
      ready=1; break
    fi
    sleep 0.1
  done
  [[ $ready == 1 ]] || { _ops_acme_error 'verified loopback ACME/DNS readiness timed out'; return 1; }
  curl -q --noproxy '*' --fail --silent --show-error --max-time 5 --cacert "$ops_acme_transport_ca" \
    "https://localhost:$management_port/roots/0" >"$ops_acme_issuer_ca" || return 1
  openssl x509 -in "$ops_acme_issuer_ca" -noout -checkend 60 >"$ops_acme_dir/issuer-check.log" 2>&1 || return 1

  cat >"$ops_acme_dir/reload-nginx.sh" <<'HOOK'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx.service
HOOK
  chmod 700 "$ops_acme_dir/reload-nginx.sh" || return 1
  # All subsequent product commands are unmodified. Global configuration is
  # essential: dry-run must not switch to a public Let's Encrypt staging CA.
  cat >"$ops_acme_dir/letsencrypt/cli.ini" <<EOF
server = $directory_url
work-dir = $ops_acme_dir/work
logs-dir = $ops_acme_dir/logs
no-random-sleep-on-renew = true
force-renewal = true
deploy-hook = $ops_acme_dir/reload-nginx.sh
EOF
  ln -s -- "$ops_acme_dir/letsencrypt" /etc/letsencrypt || return 1
  ops_acme_letsencrypt_owned=1
  ln -s -- "$ops_acme_dir/venv/bin/certbot" /usr/local/bin/certbot || return 1
  ops_acme_certbot_owned=1
  timeout 90 env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
    REQUESTS_CA_BUNDLE="$ops_acme_transport_ca" NO_PROXY='*' \
    "$ops_acme_dir/venv/bin/certbot" certonly --non-interactive --agree-tos \
    --register-unsafely-without-email --webroot --webroot-path "$ops_document_root" \
    --cert-name "$ops_fixture_id" -d "$ops_site_name" -d "$ops_second_domain" \
    >"$ops_acme_dir/initial-issuance.log" 2>&1 || { _ops_acme_error 'real local HTTP-01 initial issuance failed'; return 1; }
  openssl verify -CAfile "$ops_acme_issuer_ca" -untrusted "$ops_acme_managed_certificate_path" \
    "$ops_acme_managed_certificate_path" >"$ops_acme_dir/initial-chain.log" 2>&1 || return 1

  python3 - "$ops_site_path" "$ops_cert_path" "$ops_fixture_dir/tls-private-key.pem" "$ops_acme_managed_certificate_path" "/etc/letsencrypt/live/$ops_fixture_id/privkey.pem" <<'PY'
import os, sys
path, before_cert, before_key, after_cert, after_key = sys.argv[1:]
with open(path) as source:
    content = source.read()
for before, after in [('ssl_certificate '+before_cert+';', 'ssl_certificate '+after_cert+';'),
                      ('ssl_certificate_key '+before_key+';', 'ssl_certificate_key '+after_key+';')]:
    if content.count(before) != 1:
        raise SystemExit('owned nginx TLS reference is not unique')
    content = content.replace(before, after)
with open(path,'w') as target:
    target.write(content)
os.chmod(path,0o644)
PY
  [[ $? == 0 ]] || return 1
  nginx -t >"$ops_acme_dir/nginx-managed-check.log" 2>&1 && systemctl reload nginx.service || return 1
  local domain response deadline ready
  for domain in "$ops_site_name" "$ops_second_domain"; do
    # systemd's reload returns after HUP, before nginx's new TLS workers are
    # necessarily serving. Observe readiness without repeating any issuance or
    # reload; every attempt still verifies the new issuer and hostname.
    deadline=$((SECONDS + 15))
    ready=0
    while (( SECONDS < deadline )); do
      if response=$(curl -q --noproxy '*' --fail --silent --show-error --proto '=https' --max-time 2 \
        --cacert "$ops_acme_issuer_ca" --resolve "$domain:$ops_https_port:127.0.0.1" "https://$domain:$ops_https_port/" 2>>"$ops_acme_dir/nginx-tls-ready.log") \
        && [[ $response == "$ops_expected_body" ]]; then
        ready=1
        break
      fi
      sleep 0.1
    done
    [[ $ready == 1 ]] || { _ops_acme_error 'issued certificate HTTPS readiness did not match fixture'; return 1; }
  done
  python3 - "$ops_acme_metadata_json" "$ops_acme_dir" "$ops_fixture_id" "$ops_site_name" "$ops_second_domain" "$directory_url" "$ops_https_port" <<'PY'
import datetime, json, os, re, subprocess, sys
path, root, name, domain, second, server, port = sys.argv[1:]
certificate = '/etc/letsencrypt/live/'+name+'/fullchain.pem'
serial = subprocess.check_output(['openssl','x509','-in',certificate,'-noout','-serial'],text=True).strip().removeprefix('serial=')
expiry = subprocess.check_output(['openssl','x509','-in',certificate,'-noout','-enddate'],text=True).strip().removeprefix('notAfter=')
if not re.fullmatch(r'[A-Fa-f0-9]{1,64}',serial):
    raise SystemExit('issued certificate serial invalid')
expires = int(datetime.datetime.strptime(expiry,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
payload = dict(managedCertificatePath=certificate,certificateName=name,domains=[domain,second],
    issuerCAPath=root+'/issuer-root.pem',transportCAPath=root+'/transport-ca.pem',
    certbotBinPath=root+'/venv/bin',directoryUrl=server,initialSerial=serial,initialNotAfter=expires,httpsPort=int(port))
with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as target:
    json.dump(payload,target); target.write('\n')
PY
  [[ $? == 0 ]] || return 1
  printf 'ShellBeam ACME fixture ready: real local HTTP-01, verified ACME TLS, issued two-SAN lineage; no public CA or OS trust-store changes.\n'
}
