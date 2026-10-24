"""Fixed, bounded Linux observations. No shell, mutations or caller-supplied commands."""
import datetime
import glob
import json
import os
import re
import selectors
import subprocess
import sys
import time

MAX_BYTES = 192 * 1024
DEADLINE_SECONDS = 25


class Unavailable(Exception):
    pass


def run(argv, deadline):
    if time.monotonic() >= deadline:
        raise Unavailable("timeout")
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        raise Unavailable("tool-unavailable")
    output = bytearray()
    try:
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Unavailable("timeout")
                if not ready.select(min(remaining, 1)):
                    continue
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_BYTES:
                    raise Unavailable("output-limit")
        if process.wait(timeout=max(0.01, deadline - time.monotonic())):
            raise Unavailable("read-failed")
        return output.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        raise Unavailable("timeout")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def collect(query, deadline):
    kind = query["kind"]
    offset = query.get("offset", 0)
    limit = query.get("limit", 100)
    if not isinstance(offset, int) or not 0 <= offset <= 10000 or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise Unavailable("invalid-page")
    if kind != "logs" and ("unit" in query or "since" in query):
        raise Unavailable("invalid-log-query")
    partial = False
    rows = []
    if kind == "services":
        output = run(["systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"], deadline)
        for line in output.splitlines():
            fields = line.strip().split(None, 4)
            if len(fields) >= 4:
                rows.append(dict(unit=fields[0], load=fields[1], active=fields[2], sub=fields[3], description=fields[4] if len(fields) == 5 else ""))
    elif kind == "processes":
        output = run(["ps", "-eo", "pid=,%cpu=,%mem=,state=,comm=", "--sort=pid"], deadline)
        for line in output.splitlines():
            fields = line.strip().split(None, 4)
            if len(fields) == 5:
                rows.append(dict(pid=int(fields[0]), cpuPercent=float(fields[1]), memoryPercent=float(fields[2]), state=fields[3], name=fields[4]))
    elif kind == "containers":
        output = run(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"], deadline)
        for line in output.splitlines():
            item = json.loads(line)
            rows.append({name: item.get(key) for name, key in [("id", "ID"), ("name", "Names"), ("image", "Image"), ("status", "Status"), ("state", "State"), ("ports", "Ports")]})
    elif kind == "logs":
        since = {"5m": "5 minutes ago", "1h": "1 hour ago", "24h": "24 hours ago"}.get(query.get("since", "1h"))
        unit = query.get("unit", "")
        if not since or (unit and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,150}\.service", unit)):
            raise Unavailable("invalid-log-query")
        argv = ["journalctl", "--no-pager", "--output=json", "-n", "200", "--since", since]
        if unit:
            argv += ["--unit", unit]
        for line in run(argv, deadline).splitlines():
            item = json.loads(line)
            rows.append({"timestampMicros": item.get("__REALTIME_TIMESTAMP"), "unit": item.get("_SYSTEMD_UNIT"), "priority": item.get("PRIORITY"), "message": str(item.get("MESSAGE", ""))[:4096]})
        partial = len(rows) == 200
    elif kind == "sites":
        paths = sorted(set(glob.glob("/etc/nginx/sites-enabled/*") + glob.glob("/etc/nginx/conf.d/*.conf") + glob.glob("/etc/apache2/sites-enabled/*.conf") + glob.glob("/etc/caddy/Caddyfile")))
        partial = len(paths) > 64
        for path in paths[:64]:
            if time.monotonic() >= deadline:
                raise Unavailable("timeout")
            try:
                with open(path, "r", errors="replace") as source:
                    text = source.read(32769)
            except OSError:
                partial = True
                continue
            if len(text) > 32768:
                partial = True
                continue
            server = "nginx" if "/nginx/" in path else "apache" if "/apache2/" in path else "caddy"
            domains = re.findall(r"(?m)^\s*(?:server_name|ServerName|ServerAlias)\s+([^;\n]+)", text)
            if server == "caddy":
                domains = re.findall(r"(?m)^([^\s#{}][^{}\n]*)\s*\{", text)
            rows.append(dict(server=server, configPath=path, domains=" ".join(domains).split()[:64], status="configured"))
        # A conservative directory scan does not resolve includes or prove serving health.
        partial = True
    elif kind == "certificates":
        paths = sorted(glob.glob("/etc/letsencrypt/live/*/fullchain.pem"))
        partial = True  # Custom certificate locations are intentionally outside this scan.
        for path in paths[:32]:
            output = run(["openssl", "x509", "-in", path, "-noout", "-dates", "-subject", "-issuer", "-serial"], min(deadline, time.monotonic()+3))
            item = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
            expiry = item.get("notAfter")
            try:
                at = datetime.datetime.strptime(expiry, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
                remaining = (at - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
                expires = int(at.timestamp()*1000)
            except (TypeError, ValueError):
                remaining = None
                expires = None
            rows.append(dict(path=path, subject=item.get("subject"), issuer=item.get("issuer"), serial=item.get("serial"), notAfter=expires, daysRemaining=None if remaining is None else int(remaining//86400), status="unknown" if remaining is None else "expired" if remaining<=0 else "expiring" if remaining<2592000 else "valid"))
    else:
        raise Unavailable("invalid-kind")
    return dict(status="completed", kind=kind, entries=rows[offset:offset+limit], totalObserved=len(rows), nextOffset=offset+limit if offset+limit<len(rows) else None,
                completeness="partial" if partial else "observed", notice="Point-in-time observations under the selected SSH account. Missing entries do not prove absence; pages are recollected and can change.")


def main():
    os.environ["LC_ALL"] = "C"
    try:
        result = collect(json.loads(sys.argv[1]), time.monotonic()+DEADLINE_SECONDS)
    except Unavailable as error:
        result = dict(status="failed", error="DIAGNOSTICS_UNAVAILABLE", reason=str(error))
    except Exception:
        result = dict(status="failed", error="INVALID_DIAGNOSTICS_OUTPUT")
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
