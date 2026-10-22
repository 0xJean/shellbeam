"""Narrow Linux lifecycle helper, sent over a pinned SSH route. JSON only on stdin.
No server token, config, command output, or exception text is returned to the UI.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import uuid
import traceback
import shlex
import pwd
import hmac

LIMIT = 32 * 1024 * 1024
SERVICE_STEP = None


class Rejected(Exception):
    pass


def require(value, code):
    if not value:
        raise Rejected(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "managed_state_missing")
    require(path.stat().st_size <= 65536, "managed_state_invalid")
    return json.loads(path.read_text())


def atomic(path, data, mode=0o600):
    temp = path.with_name(path.name + ".new")
    require(not temp.is_symlink() and not path.is_symlink(), "unsafe_path")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def safe_tree(path, create=False):
    # Existing ancestors must not redirect the deployment into someone else's tree.
    for part in [*reversed(path.parents), path]:
        if not part.exists():
            require(create, "managed_path_missing")
            part.mkdir(mode=0o700)
        require(not part.is_symlink() and part.is_dir(), "unsafe_path")
        require(part.stat().st_uid in (0, os.geteuid()), "unsafe_owner")
        require(not (part.stat().st_mode & 0o022), "unsafe_permissions")


def run(arguments, allow_failure=False):
    global SERVICE_STEP
    SERVICE_STEP = next((v for v in arguments if v in ("show-user", "show-environment", "daemon-reload", "enable", "restart", "show", "is-active", "disable")), "unknown")
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    if os.geteuid() != 0:
        runtime = Path("/run/user") / str(os.geteuid())
        require(runtime.is_dir() and not runtime.is_symlink() and runtime.stat().st_uid == os.geteuid(), "user_manager_requires_linger")
        environment.update(XDG_RUNTIME_DIR=str(runtime), DBUS_SESSION_BUS_ADDRESS="unix:path=" + str(runtime / "bus"))
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=environment, timeout=15, check=False)
    require(allow_failure or result.returncode == 0, "service_command_failed")
    return result.returncode, result.stdout.decode("utf-8", errors="replace").strip()


class Service:
    def __init__(self, deployment, root):
        self.name = "shellbeam-komari-" + deployment + ".service"
        self.root = root
        self.user = os.geteuid() != 0
        self.directory = Path.home() / ".config/systemd/user" if self.user else Path("/etc/systemd/system")
        self.unit = self.directory / self.name
        self.command = ["systemctl", "--user"] if self.user else ["systemctl"]
        if self.user:
            # Never enable linger or elevate privileges implicitly.
            code, linger = run(["loginctl", "show-user", str(os.geteuid()), "-p", "Linger", "--value"], True)
            require(code == 0 and linger == "yes", "user_manager_requires_linger")
        run(self.command + ["show-environment"])

    def text(self):
        # WorkingDirectory is a single path, not an ExecStart argument: systemd
        # does not remove quotes or expand dollar variables in this directive.
        directory = str(self.root).replace("%", "%%")
        escaped = str(self.root).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
        return ("# ShellBeam managed monitoring probe\n[Unit]\nDescription=ShellBeam monitoring probe\n"
                "After=network-online.target\nWants=network-online.target\n[Service]\n"
                f'WorkingDirectory={directory}\nExecStart="{escaped}/current/agent" --config "{escaped}/config.json"\n'
                "Restart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n" +
                ("" if self.user else "PrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\n") +
                "StandardOutput=null\nStandardError=null\n[Install]\nWantedBy=" +
                ("default.target\n" if self.user else "multi-user.target\n"))

    def owned(self, absent_ok=False):
        require(not self.unit.is_symlink(), "unmanaged_service")
        if not self.unit.exists():
            require(absent_ok, "managed_service_missing")
            return
        require(self.unit.is_file() and self.unit.stat().st_uid == os.geteuid(), "unmanaged_service")
        require(self.unit.read_text() == self.text(), "unmanaged_service")

    def install(self):
        self.owned(True)
        safe_tree(self.directory, True)
        atomic(self.unit, self.text().encode(), 0o644)
        run(self.command + ["daemon-reload"])
        run(self.command + ["enable", self.name])
        run(self.command + ["restart", self.name])

    def active(self, expected):
        code, pid = run(self.command + ["show", self.name, "--property=MainPID", "--value"], True)
        if code != 0 or not pid.isdecimal() or int(pid) <= 0:
            return False
        try:
            executable = Path("/proc") / pid / "exe"
            return executable.stat().st_size <= LIMIT and digest(executable.read_bytes()) == expected and run(self.command + ["is-active", self.name], True)[0] == 0
        except OSError:
            return False

    def wait_active(self, expected):
        for _ in range(15):
            if self.active(expected):
                return True
            time.sleep(0.2)
        return False

    def incarnation(self):
        code, pid = run(self.command + ["show", self.name, "--property=MainPID", "--value"], True)
        if code != 0 or not pid.isdecimal() or int(pid) <= 0:
            return None
        try:
            # /proc stat field 22; comm may itself contain spaces/parentheses.
            start = (Path('/proc') / pid / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            require(start.isdecimal(), "process_identity_missing")
            return pid + ':' + start
        except OSError:
            return None

    def remove(self):
        self.owned(True)
        if self.unit.exists():
            run(self.command + ["disable", "--now", self.name])
            require(run(self.command + ["is-active", self.name], True)[0] != 0, "service_still_running")
            self.unit.unlink()
            run(self.command + ["daemon-reload"])
        # Inactive is not enough if a lingering process is still executing our binary.
        require(not process_in(self.root), "service_still_running")


def process_in(root):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            executable = os.readlink(entry / "exe").removesuffix(" (deleted)")
            if executable.startswith(str(root) + "/"):
                return True
        except OSError:
            continue
    return False


def is_agent_executable(executable, root):
    # The monitoring server may run on the same host. It is not an Agent.
    return ("komari-agent" in Path(executable).name.lower() or "/shellbeam/komari/" in executable) and not executable.startswith(str(root) + "/")


def existing_agent(root, ignored_executable=None, ignored_unit=None):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            executable = os.readlink(entry / "exe").removesuffix(" (deleted)")
            if executable != ignored_executable and is_agent_executable(executable, root):
                return True
        except OSError:
            continue
    for name in ("komari-agent.service",):
        for directory in (Path("/etc/systemd/system"), Path.home() / ".config/systemd/user"):
            if str(directory / name) != ignored_unit and (directory / name).exists():
                return True
    return False


def private_file(path, limit=65536):
    path = Path(path)
    require(path.is_absolute(), "legacy_layout_unsupported")
    safe_tree(path.parent)
    require(path.is_file() and not path.is_symlink() and path.stat().st_uid == os.geteuid(), "legacy_owner_mismatch")
    require(not path.stat().st_mode & 0o022 and path.stat().st_size <= limit, "legacy_file_unsafe")
    return path.read_bytes()


class LegacyService:
    """Only a direct, same-account systemd service; never run a shell or unit hooks."""
    def __init__(self, service, name):
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.service", name)
                and not name.startswith("shellbeam-"), "legacy_unit_invalid")
        self.service = service
        self.name = name
        self.unit = service.directory / name

    def info(self, pins, require_active=True):
        raw = private_file(self.unit)
        section = None
        values = {}
        allowed = {"Unit": {"Description", "After", "Wants"}, "Service": {"Type", "ExecStart", "WorkingDirectory", "Restart", "RestartSec", "User", "UMask"}, "Install": {"WantedBy"}}
        for line in raw.decode().splitlines():
            line = line.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]; require(section in allowed, "legacy_layout_unsupported"); continue
            require("=" in line and not line.endswith("\\"), "legacy_layout_unsupported")
            key, value = line.split("=", 1)
            require(key in allowed.get(section, set()) and (section, key) not in values, "legacy_layout_unsupported")
            values[section, key] = value
        require(values.get(("Service", "Type"), "simple") in ("simple", "exec"), "legacy_layout_unsupported")
        user = values.get(("Service", "User"), str(os.geteuid()))
        require((int(user) if user.isdecimal() else pwd.getpwnam(user).pw_uid) == os.geteuid(), "legacy_owner_mismatch")
        command = values.get(("Service", "ExecStart"), "")
        require(not any(c in command for c in ("%", "$", "\\", "\n", "\r")), "legacy_layout_unsupported")
        args = shlex.split(command)
        require(len(args) >= 2 and Path(args[0]).is_absolute(), "legacy_layout_unsupported")
        binary = private_file(args[0], LIMIT); sha = digest(binary)
        arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
        version = next((v for v, entries in pins.items() if entries.get(arch, {}).get("sha256") == sha and entries[arch].get("size") == len(binary)), None)
        require(version is not None, "legacy_binary_untrusted")
        config = {}; config_path = None
        if len(args) == 3 and args[1] in ("--config", "-c"):
            config_path = args[2]
            configuration = private_file(config_path)
            config = json.loads(configuration)
            require(isinstance(config, dict), "legacy_layout_unsupported")
        else:
            # Explicitly supported installer flags; unknown options are never dropped.
            kinds = {"endpoint": str, "token": str, "interval": float, "info-report-interval": int,
                     "disable-auto-update": bool, "disable-web-ssh": bool, "month-rotate": int,
                     "get-ip-addr-from-nic": bool}
            index = 1
            while index < len(args):
                word = args[index]; require(word.startswith("--"), "legacy_layout_unsupported")
                key, sep, value = word[2:].partition("=")
                require(key in kinds and key.replace("-", "_") not in config, "legacy_layout_unsupported")
                kind = kinds[key]
                if not sep:
                    if kind is bool:
                        value = "true"
                    else:
                        index += 1; require(index < len(args), "legacy_layout_unsupported"); value = args[index]
                if kind is bool:
                    require(value in ("true", "false"), "legacy_layout_unsupported"); parsed = value == "true"
                else:
                    parsed = kind(value)
                config[key.replace("-", "_")] = parsed; index += 1
            configuration = json.dumps(config).encode()
        require(isinstance(config.get("token"), str) and 0 < len(config["token"]) <= 4096
                and isinstance(config.get("endpoint"), str) and not config.get("auto_discovery_key"), "legacy_identity_missing")
        require(not config.get("ignore_unsafe_cert") and not config.get("config_file") and not config.get("host_proc"), "legacy_layout_unsupported")
        code, shown = run(self.service.command + ["show", self.name, "--property=FragmentPath,DropInPaths,Environment,EnvironmentFiles,MainPID,UnitFileState,NeedDaemonReload"], True)
        props = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
        require(code == 0 and props.get("FragmentPath") == str(self.unit) and not props.get("DropInPaths")
                and not props.get("Environment") and not props.get("EnvironmentFiles") and props.get("NeedDaemonReload") == "no", "legacy_layout_unsupported")
        enabled = props.get("UnitFileState")
        require(enabled in ("enabled", "disabled"), "legacy_layout_unsupported")
        active = run(self.service.command + ["is-active", self.name], True)[0] == 0
        if active:
            pid = props.get("MainPID", ""); require(pid.isdecimal() and int(pid) > 0, "legacy_process_mismatch")
            process = Path("/proc") / pid
            require(process.stat().st_uid == os.geteuid() and os.readlink(process / "exe") == args[0]
                    and digest((process / "exe").read_bytes()) == sha, "legacy_process_mismatch")
            require((process / "cmdline").read_bytes().rstrip(b"\0").decode().split("\0") == args, "legacy_process_mismatch")
            env = (process / "environ").read_bytes().split(b"\0")
            require(not any(x.startswith((b"AGENT_", b"HOST_PROC=")) for x in env), "legacy_layout_unsupported")
        require(not require_active or active, "legacy_not_active")
        info = {"unit": self.name, "unitSha256": digest(raw), "executable": args[0], "sha256": sha,
                "sizeBytes": len(binary), "version": version, "configPath": config_path,
                "configSha256": digest(configuration), "endpoint": config["endpoint"].rstrip("/"), "enabled": enabled == "enabled"}
        return info, config, raw, configuration, binary, active

    def match(self, expected, pins, active=None):
        found = self.info(pins, require_active=False)
        # Disabling is part of handoff; all other source facts remain frozen.
        require({k: v for k, v in found[0].items() if k != "enabled"} == {k: v for k, v in expected.items() if k != "enabled"}, "legacy_state_changed")
        require(active is None or found[-1] == active, "legacy_state_changed")
        return found

    def stop(self, info, pins):
        self.match(info, pins, True)
        run(self.service.command + ["disable", "--now", self.name])
        self.match(info, pins, False)
        for entry in Path("/proc").iterdir():
            if entry.name.isdecimal():
                try:
                    require(os.readlink(entry / "exe").removesuffix(" (deleted)") != info["executable"], "legacy_still_running")
                except OSError:
                    pass

    def restore(self, info, pins):
        self.match(info, pins, False)
        if info["enabled"]:
            run(self.service.command + ["enable", self.name])
        run(self.service.command + ["restart", self.name])
        for _ in range(15):
            try:
                self.match(info, pins, True); return
            except Rejected:
                time.sleep(0.2)
        raise Rejected("legacy_restore_unknown")


def manifest(value):
    require(isinstance(value, dict), "artifact_invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", value.get("sha256", "")), "artifact_invalid")
    require(re.fullmatch(r"1\.5\.[0-9]+", value.get("version", "")), "artifact_version_unsupported")
    require(value.get("runtime") == "komari" and value.get("platform") == "linux", "artifact_runtime_mismatch")
    expected = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    require(value.get("architecture") == expected, "artifact_architecture_mismatch")
    return value


def switch(root, sha):
    temporary = root / "current.new"
    if temporary.is_symlink():
        temporary.unlink()
    require(not temporary.exists(), "unsafe_path")
    temporary.symlink_to("releases/" + sha, target_is_directory=True)
    os.replace(temporary, root / "current")


def verify_release(root, release):
    sha = manifest(release)["sha256"]
    location = root / "releases" / sha
    safe_tree(location)
    binary = location / "agent"
    require(binary.is_file() and not binary.is_symlink() and binary.stat().st_uid == os.geteuid(), "artifact_missing")
    require(binary.stat().st_size <= LIMIT and digest(binary.read_bytes()) == sha, "artifact_hash_mismatch")
    return sha


def public_state(state):
    return dict({"active": False, "externalAgent": False, "deployment": None, "current": None, "previous": None, "configSha256": None, "job": None, "legacy": None, "endpoint": None, "previousConfigSha256": None, "configurationProcessBefore": None}, **state)


def observe(root, deployment, service, pins=None, legacy_unit=None):
    if not root.exists():
        service.owned(True)
        legacy = LegacyService(service, legacy_unit).info(pins)[0] if legacy_unit else None
        return public_state({"status": "absent", "externalAgent": bool(legacy) or existing_agent(root), "legacy": legacy})
    safe_tree(root)
    require((root / ".owner").is_file() and not (root / ".owner").is_symlink() and (root / ".owner").read_text() == deployment, "deployment_identity_mismatch")
    if not (root / "state.json").exists():
        legacy = LegacyService(service, legacy_unit).info(pins)[0] if legacy_unit else None
        return public_state({"status": "absent", "externalAgent": bool(legacy) or existing_agent(root), "legacy": legacy})
    state = read_json(root / "state.json")
    require(state.get("deployment") == deployment, "deployment_identity_mismatch")
    service.owned(state.get("status") in ("retired", "activating", "released") or state.get("legacy") is not None)
    if state.get("legacy") and not service.unit.exists() and not process_in(root):
        original = LegacyService(service, state["legacy"]["unit"]).match(state["legacy"], pins)
        if original[-1]:
            # Read-only recovery of a lost response before/after the handoff.
            return public_state(dict(state, status="released", current=None, previous=None,
                                     configSha256=None, previousConfigSha256=None,
                                     endpoint=state["legacy"]["endpoint"], active=False, externalAgent=True))
    if state.get("status") == "released":
        require(not service.unit.exists() and not process_in(root), "service_still_running")
        LegacyService(service, state["legacy"]["unit"]).match(state["legacy"], pins, True)
        return public_state(dict(state, active=False, externalAgent=True))
    if state.get("status") != "retired":
        sha = verify_release(root, state["current"])
        linked = (root / "current").is_symlink() and os.readlink(root / "current") == "releases/" + sha
        require(linked or state.get("status") == "activating", "artifact_identity_mismatch")
        config = root / "config.json"
        require(config.is_file() and not config.is_symlink() and config.stat().st_size <= 65536 and config.stat().st_mode & 0o077 == 0, "unsafe_configuration")
        actual = digest(config.read_bytes())
        accepted = [state["configSha256"]] + ([state.get("previousConfigSha256")] if state.get("status") == "activating" else [])
        require(actual in accepted, "configuration_changed")
        state = dict(state, configSha256=actual, endpoint=read_json(config).get("endpoint"), active=linked and service.active(sha))
        if state.get('configurationProcessBefore') and actual != state.get('previousConfigSha256'):
            current_process = service.incarnation()
            state['active'] = state['active'] and bool(current_process) and current_process != state['configurationProcessBefore']
        if state.get("legacy"):
            legacy = LegacyService(service, state["legacy"]["unit"]).match(state["legacy"], pins)
            state["active"] = state["active"] and not legacy[-1] and not legacy[0]["enabled"]
    else:
        require(not service.unit.exists() and not process_in(root), "service_still_running")
        state = dict(state, active=False)
    # Stored state is public metadata only. Configuration and tokens never leave this process.
    return public_state(state)


def configuration_bytes(config):
    return json.dumps(config, sort_keys=True, separators=(",", ":")).encode()


def planned_configuration(root, observed, service, request):
    if request.get("legacyUnit") and observed["status"] in ("absent", "released"):
        info, config, *_ = LegacyService(service, request["legacyUnit"]).info(request["legacyPins"])
        require(info == observed["legacy"], "legacy_state_changed")
        require(1 <= config.get("interval", 5) <= 30, "legacy_layout_unsupported")
        config.update(disable_auto_update=True, disable_web_ssh=True)
        config.setdefault("interval", 5)
        return configuration_bytes(config)
    if request.get("targetEndpoint"):
        config = read_json(root / "config.json")
        config["endpoint"] = request["targetEndpoint"]
        return configuration_bytes(config)
    if request.get("restoreConfig"):
        sha = observed.get("previousConfigSha256")
        require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha), "configuration_history_missing")
        data = private_file(root / "config-history" / (sha + ".json"))
        require(digest(data) == sha, "configuration_history_changed")
        return data
    return None


def machine_identity():
    return Path("/etc/machine-id").read_text().strip()


def perform(request):
    require(sys.platform == "linux", "linux_required")
    deployment = request.get("deployment", "")
    require(str(uuid.UUID(deployment)) == deployment, "invalid_deployment")
    action = request.get("action")
    require(action in ("inspect", "install", "upgrade", "rollback", "uninstall", "adopt", "migrate", "restore-config", "restore-legacy"), "invalid_action")
    home = Path.home()
    require(home.is_absolute() and not any(c in str(home) for c in "\n\r\x00"), "unsafe_home")
    root = home / ".local/share/shellbeam/komari" / deployment
    machine = machine_identity()
    require(re.fullmatch(r"[0-9a-f]{32}", machine), "machine_identity_missing")
    identity = {"machine": machine, "uid": os.geteuid(), "root": str(root), "architecture": {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), "unsupported")}
    if action != "inspect":
        require(request.get("identity") == identity, "machine_identity_changed")
    service = Service(deployment, root)
    pins = request.get("legacyPins", {})
    snapshot = lambda: observe(root, deployment, service, pins, request.get("legacyUnit"))
    observed = snapshot()
    if action == "inspect":
        planned = planned_configuration(root, observed, service, request)
        return {"identity": identity, "state": observed, "plannedConfig": {"sha256": digest(planned), "endpoint": json.loads(planned)["endpoint"]} if planned else None}
    require(isinstance(request.get("expected"), dict) and request["expected"] == observed, "remote_state_changed")
    if not root.exists():
        safe_tree(root, True)
        atomic(root / ".owner", deployment.encode())
    lock = os.open(root / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    legacy_lock = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if observed.get("legacy"):
            legacy_lock = os.open(root.parent / (".handoff-" + observed["legacy"]["unit"] + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(legacy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Recheck under the remote lock; another client cannot silently win the race.
        current = snapshot()
        require(current == observed, "remote_state_changed")
        legacy = current.get("legacy")
        require(action in ("uninstall", "restore-legacy") or not existing_agent(root, legacy["executable"] if legacy else None, str(service.directory / legacy["unit"]) if legacy else None), "external_agent_present")
        if action == "restore-legacy":
            require(legacy is not None and current["status"] not in ("absent", "released"), "legacy_history_missing")
            original = LegacyService(service, legacy["unit"])
            original.match(legacy, pins, False)
            service.remove()
            original.restore(legacy, pins)
            current.update(status="released", current=None, previous=None, configSha256=None, previousConfigSha256=None,
                           endpoint=legacy["endpoint"], active=False, externalAgent=True, job=request["job"])
            atomic(root / "state.json", json.dumps(current).encode())
            return {"identity": identity, "state": snapshot(), "rollback": "not-needed"}
        if action == "uninstall":
            require(current["status"] not in ("absent", "released"), "managed_state_missing")
            service.remove()
            current.pop("active", None)
            current["status"] = "retired"
            current["job"] = request["job"]
            atomic(root / "state.json", json.dumps(current).encode())
            return {"identity": identity, "state": snapshot(), "rollback": "not-needed"}
        if action in ("migrate", "restore-config"):
            require((current["active"] or action == "restore-config") and current["status"] in ("active", "activating"), "not_installed")
            old = (root / "config.json").read_bytes()
            planned = planned_configuration(root, current, service, request)
            require(planned and request.get("plannedConfig", {}).get("sha256") == digest(planned), "configuration_plan_changed")
            require(hmac.compare_digest(json.loads(old)["token"], request.get("agentToken", "")) and json.loads(planned)["token"] == json.loads(old)["token"], "legacy_node_mismatch")
            safe_tree(root / "config-history", True)
            atomic(root / "config-history" / (digest(old) + ".json"), old)
            before_process = service.incarnation()
            require(not current['active'] or before_process is not None, 'process_identity_changed')
            pending = dict(current, status="activating", configSha256=digest(planned), previousConfigSha256=digest(old), endpoint=json.loads(planned)["endpoint"], job=request["job"], configurationProcessBefore=before_process or 'not-running')
            atomic(root / "state.json", json.dumps(pending).encode())
            try:
                atomic(root / "config.json", planned)
                service.install(); require(service.wait_active(current["current"]["sha256"]), "activation_failed")
                pending["status"] = "active"; atomic(root / "state.json", json.dumps(pending).encode())
                return {"identity": identity, "state": snapshot(), "rollback": "not-needed"}
            except Exception:
                atomic(root / "config.json", old); service.install()
                require(service.wait_active(current["current"]["sha256"]), "rollback_unknown")
                current["job"] = request["job"]; atomic(root / "state.json", json.dumps(current).encode())
                return {"identity": identity, "state": snapshot(), "rollback": "verified", "error": "activation_failed"}
        adoption = action == "adopt"
        if adoption:
            require(current["status"] in ("absent", "released") and legacy is not None, "legacy_state_changed")
            original = LegacyService(service, legacy["unit"])
            info, config, unit_bytes, config_bytes, original_binary, _ = original.info(pins)
            require(info == legacy and hmac.compare_digest(config["token"], request.get("agentToken", "")), "legacy_node_mismatch")
            planned = planned_configuration(root, current, service, request)
            require(request.get("plannedConfig", {}).get("sha256") == digest(planned), "configuration_plan_changed")
            backup = root / "legacy-backups" / legacy["unitSha256"]
            safe_tree(backup, True)
            for name, data in (("service.unit", unit_bytes), ("config.json", config_bytes), ("agent", original_binary)):
                if (backup / name).exists():
                    require((backup / name).read_bytes() == data, "legacy_backup_changed")
                else:
                    atomic(backup / name, data)
        if action == "install":
            require(current["status"] in ("absent", "retired"), "already_installed")
        elif not adoption:
            require(current["status"] != "absent" and current["status"] != "retired", "not_installed")
        release = manifest(request["release"])
        if action == "rollback":
            require(current.get("previous") == release, "rollback_identity_mismatch")
        sha = release["sha256"]
        if action != "rollback":
            content = base64.b64decode(request["bytes"], validate=True)
            require(0 < len(content) <= LIMIT and len(content) == release["sizeBytes"] and digest(content) == sha, "artifact_hash_mismatch")
            directory = root / "releases" / sha
            safe_tree(directory, True)
            atomic(directory / "agent", content, 0o700)
        verify_release(root, release)
        if current["status"] == "absent" or adoption:
            config = json.loads(planned) if adoption else request["configuration"]
            require(config.get("disable_auto_update") is True and config.get("disable_web_ssh") is True, "unsafe_configuration")
            require(isinstance(config.get("token"), str) and bool(config["token"]), "configuration_missing")
            atomic(root / "config.json", planned if adoption else json.dumps(config).encode())
            config_hash = digest((root / "config.json").read_bytes())
        else:
            config_hash = current["configSha256"]
            config = root / "config.json"
            require(config.is_file() and not config.is_symlink() and config.stat().st_size <= 65536 and config.stat().st_mode & 0o077 == 0, "unsafe_configuration")
            require(digest(config.read_bytes()) == config_hash, "configuration_changed")
        previous = current.get("current") if current["status"] != "absent" and not adoption else None
        if previous:
            verify_release(root, previous)
        pending = {"deployment": deployment, "current": release, "previous": previous, "configSha256": config_hash,
                   "status": "activating", "job": request["job"], "legacy": legacy, "previousConfigSha256": current.get("previousConfigSha256")}
        atomic(root / "state.json", json.dumps(pending).encode())
        try:
            if adoption:
                original.stop(legacy, pins)
            switch(root, sha)
            service.install()
            require(service.wait_active(sha), "activation_failed")
            pending["status"] = "active"
            atomic(root / "state.json", json.dumps(pending).encode())
            return {"identity": identity, "state": snapshot(), "rollback": "not-needed"}
        except Exception:
            # Roll back only this exact managed deployment. Failure stays unknown.
            try:
                if adoption:
                    service.remove()
                    if not original.match(legacy, pins)[-1]:
                        original.restore(legacy, pins)
                    current.update(deployment=deployment, status="released", current=None, previous=None, job=request["job"])
                    atomic(root / "state.json", json.dumps(current).encode())
                elif previous and current["status"] != "retired":
                    old_sha = verify_release(root, previous)
                    switch(root, old_sha)
                    service.install()
                    require(service.wait_active(old_sha), "rollback_failed")
                    current.pop("active", None)
                    current["job"] = request["job"]
                    atomic(root / "state.json", json.dumps(current).encode())
                else:
                    service.remove()
                    pending["status"] = "retired"
                    atomic(root / "state.json", json.dumps(pending).encode())
                return {"identity": identity, "state": snapshot(), "rollback": "verified", "error": "activation_failed"}
            except Exception:
                raise Rejected("rollback_unknown") from None
    finally:
        if legacy_lock is not None:
            os.close(legacy_lock)
        os.close(lock)


def main():
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(46 * 1024 * 1024 + 1)
        require(len(raw) <= 46 * 1024 * 1024, "request_too_large")
        result = perform(json.loads(raw))
        print(json.dumps({"ok": True, **result}))
    except Rejected as error:
        print(json.dumps({"ok": False, "code": str(error), "serviceStep": SERVICE_STEP}))
    except Exception as error:
        # Only exception class and static code locations, never messages, paths,
        # request bodies, local variables or service output (which may be secret).
        locations = [{"function": frame.name, "line": frame.lineno} for frame in traceback.extract_tb(error.__traceback__)[-4:]]
        print(json.dumps({"ok": False, "code": "remote_result_unknown", "category": type(error).__name__, "locations": locations, "serviceStep": SERVICE_STEP}))


if __name__ == "__main__":
    main()
