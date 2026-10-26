import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("ci-ubuntu-mirror.py")
spec = importlib.util.spec_from_file_location("ci_ubuntu_mirror", SCRIPT)
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)

RUNNER_MIRRORS = (
    "# GitHub-hosted runner mirrors\n"
    "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
    "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
    "https://security.ubuntu.com/ubuntu/\tpriority:3\n"
)


class MirrorTests(unittest.TestCase):
    def test_existing_archive_is_preferred_and_fallbacks_are_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "apt-mirrors.txt"
            path.write_text(RUNNER_MIRRORS)
            mirror.configure_mirrors(path)
            updated = path.read_text()
            self.assertEqual(updated, RUNNER_MIRRORS.replace("priority:2", "priority:0"))
            # Repeated setup cannot accumulate mirrors or alter their contents.
            mirror.configure_mirrors(path)
            self.assertEqual(path.read_text(), updated)

    def test_unexpected_configuration_fails_without_writing(self):
        for source in [
            RUNNER_MIRRORS.replace(mirror.ARCHIVE, "http://archive.ubuntu.com/ubuntu/"),
            RUNNER_MIRRORS + f"{mirror.ARCHIVE}\tpriority:4\n",
            RUNNER_MIRRORS.replace("priority:1", "priority:0"),
            RUNNER_MIRRORS.replace("priority:1", "priority:unknown"),
            RUNNER_MIRRORS.replace("priority:1", ""),
            RUNNER_MIRRORS.replace("priority:2", "priority:2 priority:3"),
        ]:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "apt-mirrors.txt"
                path.write_text(source)
                with self.assertRaises(ValueError):
                    mirror.configure_mirrors(path)
                self.assertEqual(path.read_text(), source)

    def test_preserves_comments_and_additional_mirror_metadata(self):
        source = RUNNER_MIRRORS.replace("priority:2", "priority:2 arch:amd64 # official")
        self.assertEqual(mirror.prefer_ubuntu_archive(source), source.replace("priority:2", "priority:0"))

    def test_refuses_non_ci_and_self_hosted_before_reading_system_files(self):
        for values in [
            {"GITHUB_ACTIONS": "false", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"},
            {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted", "RUNNER_OS": "Linux"},
            {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Windows"},
        ]:
            with self.subTest(values=values):
                result = subprocess.run([sys.executable, str(SCRIPT)], env={**os.environ, **values},
                                        capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("Requires root on a disposable", result.stderr)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
