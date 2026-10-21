"""Real filesystem regression tests; service manager is an explicit unit-test fake.
The separate Linux smoke test uses the unmodified helper and actual systemd.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('agent_remote', Path(__file__).parents[1] / 'src-tauri/src/data/komari_agent/remote.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class FakeService:
    fail = set()
    current = None
    calls = []
    def __init__(self, deployment, root):
        self.root = root
        self.unit = root.parent / (deployment + '.service')
    def owned(self, absent_ok=False):
        helper.require(not self.unit.exists() or self.unit.read_text() == 'managed', 'unmanaged_service')
        helper.require(absent_ok or self.unit.exists(), 'managed_service_missing')
    def install(self):
        self.calls.append('install')
        self.unit.write_text('managed')
        FakeService.current = helper.digest((self.root / 'current/agent').read_bytes())
    def active(self, expected):
        return self.unit.exists() and self.current == expected and expected not in self.fail
    def wait_active(self, expected):
        return self.active(expected)
    def remove(self):
        self.calls.append('remove')
        self.owned(True)
        self.unit.unlink(missing_ok=True)
        FakeService.current = None

class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.shellbeam-komari-unit-', dir=Path.home())
        self.home = Path(self.temp.name)
        self.deployment = str(uuid.uuid4())
        self.root = self.home / '.local/share/shellbeam/komari' / self.deployment
        self.patches = [patch.object(helper.Path, 'home', return_value=self.home), patch.object(helper.sys, 'platform', 'linux'), patch.object(helper.platform, 'machine', return_value='x86_64'), patch.object(helper, 'machine_identity', return_value='a' * 32), patch.object(helper, 'Service', FakeService), patch.object(helper, 'existing_agent', return_value=False), patch.object(helper, 'process_in', return_value=False)]
        for p in self.patches: p.start()
        FakeService.fail = set(); FakeService.current = None; FakeService.calls = []
        self.config = {'endpoint': 'http://fixture.invalid', 'token': 'isolated-unit-key', 'disable_auto_update': True, 'disable_web_ssh': True}
    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()
    def inspect(self):
        return helper.perform({'action': 'inspect', 'deployment': self.deployment})
    def release(self, version, content):
        return {'runtime': 'komari', 'version': version, 'platform': 'linux', 'architecture': 'amd64', 'sha256': helper.digest(content), 'sizeBytes': len(content), 'url': 'https://fixture.invalid/binary', 'signature': 'verified-by-native-test-boundary'}
    def operate(self, action, release=None, content=None, expected=None):
        before = expected or self.inspect()
        return helper.perform({'deployment': self.deployment, 'action': action, 'identity': before['identity'], 'expected': before['state'], 'job': str(uuid.uuid4()), 'release': release, 'bytes': base64.b64encode(content).decode() if content is not None else None, 'configuration': self.config})
    def installed(self):
        r = self.release('1.5.10', b'old-agent')
        self.operate('install', r, b'old-agent')
        return r
    def test_install_upgrade_rollback_uninstall_preserve_configuration_and_versions(self):
        old = self.installed(); configuration = (self.root / 'config.json').read_bytes()
        new = self.release('1.5.11', b'new-agent')
        self.assertTrue(self.operate('upgrade', new, b'new-agent')['state']['active'])
        reverted = self.operate('rollback', old)
        self.assertEqual(reverted['state']['current'], old)
        stopped = self.operate('uninstall')
        self.assertEqual(stopped['state']['status'], 'retired'); self.assertFalse(stopped['state']['active'])
        self.assertEqual((self.root / 'config.json').read_bytes(), configuration)
        self.assertEqual((self.root / 'config.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list((self.root / 'releases').iterdir())), 2)
        self.assertNotIn('isolated-unit-key', json.dumps(stopped))
    def test_failed_activation_restores_previous_process_and_journal(self):
        old = self.installed(); new = self.release('1.5.11', b'broken-agent'); FakeService.fail.add(new['sha256'])
        result = self.operate('upgrade', new, b'broken-agent')
        self.assertEqual(result['rollback'], 'verified'); self.assertEqual(result['error'], 'activation_failed')
        self.assertEqual(result['state']['current'], old); self.assertTrue(result['state']['active'])
    def test_checksum_rejected_before_switching_or_restarting(self):
        self.installed(); before = self.inspect(); calls = list(FakeService.calls)
        with self.assertRaisesRegex(helper.Rejected, 'artifact_hash_mismatch'):
            self.operate('upgrade', self.release('1.5.11', b'expected'), b'bad')
        self.assertEqual(self.inspect(), before); self.assertEqual(FakeService.calls, calls)
    def test_old_preview_and_changed_machine_cannot_mutate(self):
        before = self.inspect(); self.installed()
        with self.assertRaisesRegex(helper.Rejected, 'remote_state_changed'):
            self.operate('uninstall', expected=before)
        with patch.object(helper, 'machine_identity', return_value='b' * 32):
            with self.assertRaisesRegex(helper.Rejected, 'machine_identity_changed'):
                self.operate('uninstall', expected=before)
    def test_readback_is_read_only_and_handles_activation_crash_before_switch(self):
        old = self.installed(); new = self.release('1.5.11', b'new-agent')
        directory = self.root / 'releases' / new['sha256']; directory.mkdir(); (directory / 'agent').write_bytes(b'new-agent')
        journal = json.loads((self.root / 'state.json').read_text()); journal.update(status='activating', current=new, previous=old)
        (self.root / 'state.json').write_text(json.dumps(journal))
        before = {str(p): (p.stat().st_mtime_ns, p.read_bytes()) for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}
        calls = list(FakeService.calls)
        state = self.inspect()['state']; self.assertEqual(state['status'], 'activating'); self.assertFalse(state['active'])
        after = {str(p): (p.stat().st_mtime_ns, p.read_bytes()) for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}
        self.assertEqual(before, after); self.assertEqual(FakeService.calls, calls)
        self.assertEqual(self.operate('uninstall')['state']['status'], 'retired')
    def test_does_not_adopt_existing_or_redirected_services(self):
        with patch.object(helper, 'existing_agent', return_value=True):
            with self.assertRaisesRegex(helper.Rejected, 'external_agent_present'):
                self.operate('install', self.release('1.5.10', b'old-agent'), b'old-agent')
        self.installed(); service = FakeService(self.deployment, self.root); service.unit.write_text('someone else')
        with self.assertRaisesRegex(helper.Rejected, 'unmanaged_service'): self.operate('uninstall')
    def test_configuration_symlink_or_permissions_cannot_be_reused(self):
        old = self.installed(); self.operate('uninstall')
        (self.root / 'config.json').chmod(0o644)
        with self.assertRaisesRegex(helper.Rejected, 'unsafe_configuration'): self.operate('install', old, b'old-agent')
        (self.root / 'config.json').unlink(); (self.root / 'config.json').symlink_to(self.home / 'another.json')
        with self.assertRaisesRegex(helper.Rejected, 'unsafe_configuration'): self.operate('install', old, b'old-agent')

if __name__ == '__main__': unittest.main()
