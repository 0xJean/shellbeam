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
        # Root is an owned fixed path with no unit specifiers or quoting ambiguity.
        escaped = str(self.root).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
        return ("# ShellBeam managed monitoring probe\n[Unit]\nDescription=ShellBeam monitoring probe\n"
                "After=network-online.target\nWants=network-online.target\n[Service]\n"
                f'WorkingDirectory="{escaped}"\nExecStart="{escaped}/current/agent" --config "{escaped}/config.json"\n'
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


def existing_agent(root):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            executable = os.readlink(entry / "exe").removesuffix(" (deleted)")
            if is_agent_executable(executable, root):
                return True
        except OSError:
            continue
    for name in ("komari-agent.service",):
        for directory in (Path("/etc/systemd/system"), Path.home() / ".config/systemd/user"):
            if (directory / name).exists():
                return True
    return False


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
    return dict({"active": False, "externalAgent": False, "deployment": None, "current": None, "previous": None, "configSha256": None, "job": None}, **state)


def observe(root, deployment, service):
    if not root.exists():
        service.owned(True)
        return public_state({"status": "absent", "externalAgent": existing_agent(root)})
    safe_tree(root)
    require((root / ".owner").is_file() and not (root / ".owner").is_symlink() and (root / ".owner").read_text() == deployment, "deployment_identity_mismatch")
    if not (root / "state.json").exists():
        return public_state({"status": "absent", "externalAgent": existing_agent(root)})
    state = read_json(root / "state.json")
    require(state.get("deployment") == deployment, "deployment_identity_mismatch")
    service.owned(state.get("status") in ("retired", "activating"))
    if state.get("status") != "retired":
        sha = verify_release(root, state["current"])
        linked = (root / "current").is_symlink() and os.readlink(root / "current") == "releases/" + sha
        require(linked or state.get("status") == "activating", "artifact_identity_mismatch")
        config = root / "config.json"
        require(config.is_file() and not config.is_symlink() and config.stat().st_size <= 65536 and config.stat().st_mode & 0o077 == 0, "unsafe_configuration")
        require(digest(config.read_bytes()) == state["configSha256"], "configuration_changed")
        state = dict(state, active=linked and service.active(sha))
    else:
        require(not service.unit.exists() and not process_in(root), "service_still_running")
        state = dict(state, active=False)
    # Stored state is public metadata only. Configuration and tokens never leave this process.
    return public_state(state)


def machine_identity():
    return Path("/etc/machine-id").read_text().strip()


def perform(request):
    require(sys.platform == "linux", "linux_required")
    deployment = request.get("deployment", "")
    require(str(uuid.UUID(deployment)) == deployment, "invalid_deployment")
    action = request.get("action")
    require(action in ("inspect", "install", "upgrade", "rollback", "uninstall"), "invalid_action")
    home = Path.home()
    require(home.is_absolute() and not any(c in str(home) for c in "\n\r\x00"), "unsafe_home")
    root = home / ".local/share/shellbeam/komari" / deployment
    machine = machine_identity()
    require(re.fullmatch(r"[0-9a-f]{32}", machine), "machine_identity_missing")
    identity = {"machine": machine, "uid": os.geteuid(), "root": str(root), "architecture": {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), "unsupported")}
    if action != "inspect":
        require(request.get("identity") == identity, "machine_identity_changed")
    service = Service(deployment, root)
    observed = observe(root, deployment, service)
    if action == "inspect":
        return {"identity": identity, "state": observed}
    require(isinstance(request.get("expected"), dict) and request["expected"] == observed, "remote_state_changed")
    if not root.exists():
        safe_tree(root, True)
        atomic(root / ".owner", deployment.encode())
    lock = os.open(root / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Recheck under the remote lock; another client cannot silently win the race.
        current = observe(root, deployment, service)
        require(current == observed, "remote_state_changed")
        require(action == "uninstall" or not existing_agent(root), "external_agent_present")
        if action == "uninstall":
            require(current["status"] != "absent", "managed_state_missing")
            service.remove()
            current.pop("active", None)
            current["status"] = "retired"
            current["job"] = request["job"]
            atomic(root / "state.json", json.dumps(current).encode())
            return {"identity": identity, "state": observe(root, deployment, service), "rollback": "not-needed"}
        if action == "install":
            require(current["status"] in ("absent", "retired"), "already_installed")
        else:
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
        if current["status"] == "absent":
            config = request["configuration"]
            require(config.get("disable_auto_update") is True and config.get("disable_web_ssh") is True, "unsafe_configuration")
            require(isinstance(config.get("token"), str) and bool(config["token"]), "configuration_missing")
            atomic(root / "config.json", json.dumps(config).encode())
            config_hash = digest((root / "config.json").read_bytes())
        else:
            config_hash = current["configSha256"]
            config = root / "config.json"
            require(config.is_file() and not config.is_symlink() and config.stat().st_size <= 65536 and config.stat().st_mode & 0o077 == 0, "unsafe_configuration")
            require(digest(config.read_bytes()) == config_hash, "configuration_changed")
        previous = current.get("current") if current["status"] != "absent" else None
        if previous:
            verify_release(root, previous)
        pending = {"deployment": deployment, "current": release, "previous": previous, "configSha256": config_hash,
                   "status": "activating", "job": request["job"]}
        atomic(root / "state.json", json.dumps(pending).encode())
        try:
            switch(root, sha)
            service.install()
            require(service.wait_active(sha), "activation_failed")
            pending["status"] = "active"
            atomic(root / "state.json", json.dumps(pending).encode())
            return {"identity": identity, "state": observe(root, deployment, service), "rollback": "not-needed"}
        except Exception:
            # Roll back only this exact managed deployment. Failure stays unknown.
            try:
                if previous and current["status"] != "retired":
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
                return {"identity": identity, "state": observe(root, deployment, service), "rollback": "verified", "error": "activation_failed"}
            except Exception:
                raise Rejected("rollback_unknown") from None
    finally:
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
