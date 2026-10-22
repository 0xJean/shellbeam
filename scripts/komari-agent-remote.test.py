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
    generation = 0
    calls = []
    def __init__(self, deployment, root):
        self.root = root
        self.directory = root.parent
        self.unit = root.parent / (deployment + '.service')
    def owned(self, absent_ok=False):
        helper.require(not self.unit.exists() or self.unit.read_text() == 'managed', 'unmanaged_service')
        helper.require(absent_ok or self.unit.exists(), 'managed_service_missing')
    def install(self):
        FakeService.generation += 1
        self.calls.append('install')
        self.unit.write_text('managed')
        FakeService.current = helper.digest((self.root / 'current/agent').read_bytes())
    def active(self, expected):
        return self.unit.exists() and self.current == expected and expected not in self.fail
    def wait_active(self, expected):
        return self.active(expected)
    def incarnation(self):
        return str(self.generation) if self.unit.exists() else None
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

class FakeLegacy(helper.LegacyService):
    running = True
    enabled = True
    def info(self, pins, require_active=True):
        raw = self.unit.read_bytes(); config_path = self.unit.with_suffix('.json'); data = config_path.read_bytes()
        binary = self.unit.with_suffix('.agent').read_bytes(); config = json.loads(data)
        helper.require(not require_active or self.running, 'legacy_not_active')
        info = {'unit': self.name, 'unitSha256': helper.digest(raw), 'executable': str(self.unit.with_suffix('.agent')),
                'sha256': helper.digest(binary), 'sizeBytes': len(binary), 'version': '1.5.10',
                'configPath': str(config_path), 'configSha256': helper.digest(data), 'endpoint': config['endpoint'], 'enabled': self.enabled}
        return info, config, raw, data, binary, self.running
    def stop(self, info, pins):
        self.match(info, pins, True); FakeLegacy.running = False; FakeLegacy.enabled = False
    def restore(self, info, pins):
        self.match(info, pins, False); FakeLegacy.running = True; FakeLegacy.enabled = info['enabled']

class Handoff(Lifecycle):
    def setUp(self):
        super().setUp()
        self.legacy_patch = patch.object(helper, 'LegacyService', FakeLegacy); self.legacy_patch.start()
        FakeLegacy.running = True; FakeLegacy.enabled = True
        helper.safe_tree(self.root.parent, True)
        self.unit_name = 'existing-agent.service'; self.unit = self.root.parent / self.unit_name
        self.unit.write_text('untouched original unit')
        self.unit.with_suffix('.agent').write_bytes(b'original probe')
        self.unit.with_suffix('.json').write_text(json.dumps({**self.config, 'include_nics': 'eth*', 'interval': 7}))
    def tearDown(self):
        self.legacy_patch.stop(); super().tearDown()
    def preview(self, **extra):
        return helper.perform({'action':'inspect', 'deployment':self.deployment, 'legacyPins':{}, **extra})
    def handoff(self, action, artifact=None, content=None, preview=None, **extra):
        before = preview or self.preview(**extra)
        return helper.perform({'action':action, 'deployment':self.deployment, 'identity':before['identity'], 'expected':before['state'],
            'job':str(uuid.uuid4()), 'release':artifact, 'bytes':base64.b64encode(content).decode() if content else None,
            'legacyPins':{}, 'agentToken':self.config['token'], 'plannedConfig':before.get('plannedConfig'), **extra})
    def adopt(self, content=b'new-agent'):
        return self.handoff('adopt', self.release('1.5.11',content), content, legacyUnit=self.unit_name)
    def test_adoption_keeps_original_files_token_custom_options_and_can_return_ownership(self):
        original = {p:p.read_bytes() for p in self.unit.parent.glob('existing-agent.*')}
        result=self.adopt(); self.assertTrue(result['state']['active']); self.assertFalse(FakeLegacy.running)
        config=json.loads((self.root/'config.json').read_text())
        self.assertEqual(config['token'],self.config['token']); self.assertEqual(config['include_nics'],'eth*'); self.assertEqual(config['interval'],7)
        self.assertTrue(config['disable_web_ssh']); self.assertTrue(config['disable_auto_update'])
        restored=self.handoff('restore-legacy'); self.assertEqual(restored['state']['status'],'released'); self.assertTrue(FakeLegacy.running)
        self.assertEqual({p:p.read_bytes() for p in original},original)
        self.assertEqual(len(list((self.root/'legacy-backups').rglob('service.unit'))),1)
        self.assertNotIn(self.config['token'],json.dumps(result)+json.dumps(restored))
    def test_adoption_failure_restores_original_service_and_persists_readable_outcome(self):
        FakeService.fail.add(helper.digest(b'new-agent'))
        result=self.adopt(); self.assertEqual(result['rollback'],'verified'); self.assertEqual(result['state']['status'],'released')
        self.assertTrue(FakeLegacy.running); self.assertFalse(result['state']['active'])
        self.assertEqual(self.preview()['state']['status'],'released')
    def test_changed_original_and_wrong_node_do_not_stop_service(self):
        before=self.preview(legacyUnit=self.unit_name); self.unit.write_text('external change')
        with self.assertRaisesRegex(helper.Rejected,'remote_state_changed'):
            self.handoff('adopt', self.release('1.5.11',b'new-agent'), b'new-agent', preview=before, legacyUnit=self.unit_name)
        with self.assertRaisesRegex(helper.Rejected,'legacy_node_mismatch'):
            self.handoff('adopt', self.release('1.5.11',b'new-agent'), b'new-agent', legacyUnit=self.unit_name, agentToken='wrong-node')
        self.assertTrue(FakeLegacy.running); self.assertEqual(FakeService.calls,[])
    def test_migration_preserves_previous_exact_configuration_and_restores_without_download(self):
        self.installed(); old=(self.root/'config.json').read_bytes()
        moved=self.handoff('migrate', targetEndpoint='http://new-address.invalid')
        self.assertEqual(moved['state']['endpoint'],'http://new-address.invalid'); self.assertTrue(moved['state']['active'])
        self.assertEqual(json.loads((self.root/'config.json').read_bytes())['token'],self.config['token'])
        restored=self.handoff('restore-config', restoreConfig=True)
        self.assertEqual(restored['state']['endpoint'],self.config['endpoint']); self.assertEqual((self.root/'config.json').read_bytes(),old)
        self.assertEqual((self.root/'config-history'/ (helper.digest(old)+'.json')).read_bytes(),old)
    def test_handoff_crash_is_read_only_and_explicit_restore_is_available(self):
        self.adopt(); journal=self.root/'state.json'; state=json.loads(journal.read_text())
        service=FakeService(self.deployment,self.root); service.remove(); FakeLegacy.running=True; FakeLegacy.enabled=True
        state['status']='activating'; journal.write_text(json.dumps(state)); before=journal.read_bytes(); calls=list(FakeService.calls)
        self.assertEqual(self.preview()['state']['status'],'released')
        self.assertEqual(journal.read_bytes(),before); self.assertEqual(FakeService.calls,calls)
    def test_configuration_write_interruption_is_inspected_without_replay(self):
        self.installed(); original=(self.root/'config.json').read_bytes()
        preview=self.preview(targetEndpoint='http://next.invalid'); journal=self.root/'state.json'; state=json.loads(journal.read_text())
        state.update(status='activating',configSha256=preview['plannedConfig']['sha256'],previousConfigSha256=helper.digest(original))
        journal.write_text(json.dumps(state)); before=journal.read_bytes(); calls=list(FakeService.calls)
        observed=self.preview()['state']; self.assertEqual(observed['endpoint'],self.config['endpoint'])
        self.assertEqual(observed['configSha256'],helper.digest(original)); self.assertEqual(journal.read_bytes(),before); self.assertEqual(FakeService.calls,calls)
    def test_configuration_written_without_restart_is_not_verified_as_applied(self):
        self.installed(); original=(self.root/'config.json').read_bytes()
        preview=self.preview(targetEndpoint='http://next.invalid'); journal=self.root/'state.json'; state=json.loads(journal.read_text())
        config=json.loads(original); config['endpoint']='http://next.invalid'
        state.update(status='activating',configSha256=preview['plannedConfig']['sha256'],previousConfigSha256=helper.digest(original),configurationProcessBefore=FakeService(self.deployment,self.root).incarnation())
        helper.safe_tree(self.root/'config-history',True); helper.atomic(self.root/'config-history'/(helper.digest(original)+'.json'),original)
        journal.write_text(json.dumps(state)); helper.atomic(self.root/'config.json',helper.configuration_bytes(config))
        before=journal.read_bytes(); calls=list(FakeService.calls)
        self.assertFalse(self.preview()['state']['active']); self.assertEqual(journal.read_bytes(),before); self.assertEqual(FakeService.calls,calls)
        restored=self.handoff('restore-config',restoreConfig=True)
        self.assertTrue(restored['state']['active']); self.assertEqual((self.root/'config.json').read_bytes(),original)
    def test_failed_address_restart_restores_exact_previous_configuration(self):
        self.installed(); old=(self.root/'config.json').read_bytes()
        with patch.object(FakeService,'wait_active',side_effect=[False,True]):
            result=self.handoff('migrate',targetEndpoint='http://next.invalid')
        self.assertEqual(result['rollback'],'verified'); self.assertTrue(result['state']['active'])
        self.assertEqual((self.root/'config.json').read_bytes(),old)
    def test_changed_original_cannot_stop_managed_service_during_return(self):
        self.adopt(); self.unit.write_text('external edit'); calls=list(FakeService.calls)
        with self.assertRaisesRegex(helper.Rejected,'legacy_state_changed'): self.handoff('restore-legacy')
        self.assertEqual(FakeService.calls,calls); self.assertFalse(FakeLegacy.running)

class LegacyParsing(unittest.TestCase):
    """Real parser/files; only systemctl output is fake, never a running service."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.shellbeam-legacy-parser-', dir=Path.home())
        self.directory = Path(self.temp.name)
        self.binary = self.directory / 'agent'; self.binary.write_bytes(b'reviewed-isolated-binary')
        self.config = self.directory / 'config.json'
        self.settings = {'endpoint': 'http://fixture.invalid', 'token': 'synthetic-private-token', 'include_nics': 'lo'}
        self.config.write_text(json.dumps(self.settings))
        self.unit = self.directory / 'komari-agent.service'
        self.text = '[Unit]\nDescription=Existing\n[Service]\nType=simple\nExecStart=' + str(self.binary) + ' --config ' + str(self.config) + '\n[Install]\nWantedBy=default.target\n'
        self.unit.write_text(self.text)
        service = type('Service', (), {'directory': self.directory, 'command': ['systemctl', '--user']})()
        self.legacy = helper.LegacyService(service, self.unit.name)
        self.pins = {'1.5.11': {'amd64': {'sha256': helper.digest(self.binary.read_bytes()), 'size': self.binary.stat().st_size}}}
        self.properties = {'FragmentPath': str(self.unit), 'DropInPaths': '', 'Environment': '', 'EnvironmentFiles': '', 'NeedDaemonReload': 'no', 'UnitFileState': 'disabled', 'MainPID': '0'}
        def command(args, allow_failure=False):
            if 'show' in args: return 0, '\n'.join(k+'='+v for k,v in self.properties.items())
            if 'is-active' in args: return 3, 'inactive'
            self.fail('Parser must never mutate a service')
        self.mocks = [patch.object(helper, 'run', side_effect=command), patch.object(helper.platform, 'machine', return_value='x86_64')]
        for mock in self.mocks: mock.start()
    def tearDown(self):
        for mock in reversed(self.mocks): mock.stop()
        self.temp.cleanup()
    def test_configuration_preserved_but_secret_not_in_public_identity(self):
        info, config, unit, raw, binary, active = self.legacy.info(self.pins, False)
        self.assertEqual(config, self.settings); self.assertEqual(raw, self.config.read_bytes())
        self.assertEqual(unit, self.unit.read_bytes()); self.assertFalse(active)
        self.assertNotIn(self.settings['token'], json.dumps(info)); self.assertEqual(info['sha256'], helper.digest(binary))
    def test_only_reviewed_bytes_are_accepted(self):
        self.binary.write_bytes(b'changed')
        with self.assertRaisesRegex(helper.Rejected, 'legacy_binary_untrusted'): self.legacy.info(self.pins, False)
    def test_unit_hooks_and_shell_commands_are_rejected(self):
        for directive in ('ExecStartPre=/bin/true', 'ExecStop=/bin/true', 'Environment=AGENT_TOKEN=hidden'):
            self.unit.write_text(self.text.replace('[Install]', directive+'\n[Install]'))
            with self.assertRaisesRegex(helper.Rejected, 'legacy_layout_unsupported'): self.legacy.info(self.pins, False)
        self.unit.write_text(self.text.replace(str(self.binary), '/bin/sh -c'))
        with self.assertRaises(helper.Rejected): self.legacy.info(self.pins, False)
    def test_dropins_stale_units_and_environment_overrides_are_rejected(self):
        for key, value in [('DropInPaths', '/a/override.conf'), ('Environment', 'AGENT_TOKEN=hidden'), ('EnvironmentFiles', '/a/env'), ('NeedDaemonReload', 'yes')]:
            old = self.properties[key]; self.properties[key] = value
            with self.assertRaisesRegex(helper.Rejected, 'legacy_layout_unsupported'): self.legacy.info(self.pins, False)
            self.properties[key] = old
    def test_symlink_or_writable_original_configuration_is_rejected(self):
        self.config.chmod(0o666)
        with self.assertRaisesRegex(helper.Rejected, 'legacy_file_unsafe'): self.legacy.info(self.pins, False)
        self.config.chmod(0o600); saved=self.directory/'retained.json'; self.config.rename(saved); self.config.symlink_to(saved)
        with self.assertRaisesRegex(helper.Rejected, 'legacy_owner_mismatch'): self.legacy.info(self.pins, False)
    def test_supported_installer_flags_preserve_values_without_exposing_token(self):
        self.unit.write_text(self.text.replace('--config '+str(self.config), '--endpoint http://fixture.invalid --token synthetic-private-token --interval 5 --disable-auto-update --disable-web-ssh=false'))
        info, config, *_ = self.legacy.info(self.pins, False)
        self.assertEqual(config['interval'], 5); self.assertTrue(config['disable_auto_update']); self.assertFalse(config['disable_web_ssh'])
        self.assertNotIn(self.settings['token'], json.dumps(info))
        self.unit.write_text(self.unit.read_text().replace('--interval 5', '--unknown-setting 5'))
        with self.assertRaisesRegex(helper.Rejected, 'legacy_layout_unsupported'): self.legacy.info(self.pins, False)

class ProcessRecognition(unittest.TestCase):
    def test_only_pinned_agent_configuration_environment_is_rejected(self):
        helper.check_legacy_environment([b'AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache', b'AGENT_ALLOW_RUNASROOT=1', b'HOME=/home/runner'])
        for name in ('AGENT_TOKEN', 'AGENT_ENDPOINT', 'AGENT_CONFIG_FILE', 'AGENT_INCLUDE_NICS', 'AGENT_DISABLE_WEB_SSH', 'AGENT_PREFER_IP_VERSION', 'HOST_PROC'):
            with self.assertRaisesRegex(helper.Rejected, 'legacy_environment_unsupported'):
                helper.check_legacy_environment([(name+'=synthetic-private-value').encode()])

    def test_service_directory_uses_path_syntax_separate_from_command_quoting(self):
        service = object.__new__(helper.Service)
        service.root = Path('/home/test space/$name%quote"/managed')
        service.user = True
        text = service.text()
        self.assertIn('WorkingDirectory=/home/test space/$name%%quote"/managed\n', text)
        self.assertIn('ExecStart="/home/test space/$$name%%quote\\"/managed/current/agent"', text)
        self.assertNotIn('WorkingDirectory="', text)

    def test_monitoring_server_is_not_mistaken_for_an_existing_agent(self):
        root = Path('/home/test/.local/share/shellbeam/komari/owned')
        self.assertFalse(helper.is_agent_executable('/usr/local/bin/komari', root))
        self.assertFalse(helper.is_agent_executable('/tmp/komari-linux-amd64-1.6.0', root))
        self.assertTrue(helper.is_agent_executable('/usr/local/bin/komari-agent', root))
        self.assertTrue(helper.is_agent_executable('/opt/komari-agent-linux-arm64', root))
        self.assertFalse(helper.is_agent_executable(str(root / 'releases/hash/agent'), root))
        self.assertTrue(helper.is_agent_executable('/home/test/.local/share/shellbeam/komari/other/releases/hash/agent', root))

if __name__ == '__main__': unittest.main()
