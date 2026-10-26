#!/usr/bin/env python3
"""Prefer the runner's existing official Ubuntu archive for disposable GUI CI."""

import os
from pathlib import Path
import re
import sys


ARCHIVE = "https://archive.ubuntu.com/ubuntu/"


def prefer_ubuntu_archive(source):
    # Keep the runner's mirrors, suites, components and package trust unchanged.
    # Only promote its existing HTTPS archive above the slow Azure mirror.
    lines = source.splitlines(keepends=True)
    matches = []
    for index, line in enumerate(lines):
        fields = line.split("#", 1)[0].split()
        if not fields:
            continue
        priorities = [field for field in fields[1:] if field.startswith("priority:")]
        if len(priorities) != 1 or not re.fullmatch(r"priority:[0-9]+", priorities[0]):
            raise ValueError("Unexpected runner mirror priority; refusing to change it")
        if fields[0] == ARCHIVE:
            matches.append(index)
        elif int(priorities[0].split(":")[1]) == 0:
            raise ValueError("Another mirror already has highest priority")
    if len(matches) != 1:
        raise ValueError("Expected exactly one existing official HTTPS Ubuntu archive")
    index = matches[0]
    lines[index] = re.sub(r"\bpriority:[0-9]+", "priority:0", lines[index], count=1)
    return "".join(lines)


def configure_mirrors(path):
    source = path.read_text()
    updated = prefer_ubuntu_archive(source)
    if updated != source:
        path.write_text(updated)


def main():
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("RUNNER_OS") != "Linux"
            or sys.platform != "linux"
            or os.geteuid() != 0):
        raise SystemExit("Requires root on a disposable GitHub-hosted Linux runner")
    configure_mirrors(Path("/etc/apt/apt-mirrors.txt"))
    print("APT: existing official HTTPS Ubuntu archive preferred; fallback mirrors retained")


if __name__ == "__main__":
    main()
