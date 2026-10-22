"""Operator host-activation checks; no real DSH business calls."""
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hostdeploy', pathlib.Path(__file__).with_name('deploy-platform-host.review.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

PIN = ':'.join(['ab'] * 32)


class HostActivationTests(unittest.TestCase):
    def test_candidate_preserves_v1_and_pins_existing_relay_identity(self):
        original = {'version': 1, 'enabled': True,
                    'semanticBridge': {'enabled': True, 'clientFingerprintSha256': PIN}}
        saved = copy.deepcopy(original)
        candidate = d.candidate_config(original, PIN)
        self.assertEqual(original, saved)
        self.assertEqual({k: v for k, v in candidate.items() if k != 'platformAdmin'}, original)
        self.assertEqual(candidate['platformAdmin']['clientFingerprintSha256'], PIN)
        self.assertEqual(candidate['platformAdmin']['allowedActions'], d.ACTIONS)
        self.assertTrue(candidate['platformAdmin']['exclusiveReplayWriter'])

    def test_mismatched_peer_pin_denies_before_activation(self):
        original = {'semanticBridge': {'enabled': True, 'clientFingerprintSha256': PIN}}
        with self.assertRaises(RuntimeError):
            d.candidate_config(original, ':'.join(['cd'] * 32))

    def test_existing_enabled_platform_authority_is_not_overwritten(self):
        original = {'semanticBridge': {'enabled': True, 'clientFingerprintSha256': PIN},
                    'platformAdmin': {'enabled': True}}
        with self.assertRaises(RuntimeError):
            d.candidate_config(original, PIN)

    def test_atomic_replace_rejects_concurrent_edit_and_preserves_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / 'runtime.json'
            target.write_bytes(b'original')
            target.chmod(0o640)
            d.replace_checked(target, b'original', b'candidate')
            self.assertEqual(target.read_bytes(), b'candidate')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            with self.assertRaises(RuntimeError):
                d.replace_checked(target, b'original', b'overwrite')
            self.assertEqual(target.read_bytes(), b'candidate')

    def test_startup_failure_restores_exact_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / 'runtime.json'
            target.write_bytes(b'original')
            calls = []
            def restart():
                calls.append(target.read_bytes())
                if len(calls) == 1:
                    raise RuntimeError('startup_failed')
            with self.assertRaises(RuntimeError):
                d.activate_with_rollback(target, b'original', b'candidate', restart)
            self.assertEqual(target.read_bytes(), b'original')
            self.assertEqual(calls, [b'candidate', b'original'])

    def test_concurrent_runtime_change_is_not_overwritten_by_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / 'runtime.json'
            target.write_bytes(b'original')
            def restart():
                target.write_bytes(b'other-operator-change')
                raise RuntimeError('startup_failed')
            with self.assertRaisesRegex(RuntimeError, 'concurrent_runtime_change'):
                d.activate_with_rollback(target, b'original', b'candidate', restart)
            self.assertEqual(target.read_bytes(), b'other-operator-change')

    def test_runtime_symlink_is_rejected_without_modifying_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            victim, link = root / 'original', root / 'runtime.json'
            victim.write_bytes(b'original')
            link.symlink_to(victim)
            with self.assertRaises(RuntimeError):
                d.replace_checked(link, b'original', b'candidate')
            self.assertEqual(victim.read_bytes(), b'original')
            self.assertTrue(link.is_symlink())

    @unittest.skipUnless(os.environ.get('DSH_RELAY_DOCKER_TEST_IMAGE'), 'Docker smoke runs explicitly in CI')
    def test_real_docker_restart_observes_atomic_bind_file_replacement(self):
        name = 'dsh-host-config-test-' + uuid.uuid4().hex
        image = os.environ['DSH_RELAY_DOCKER_TEST_IMAGE']
        with tempfile.TemporaryDirectory() as tmp:
            folder = pathlib.Path(tmp)
            folder.chmod(0o755)
            config = folder / 'runtime.json'
            config.write_bytes(b'first')
            config.chmod(0o444)
            command = "console.log(require('fs').readFileSync('/runtime.json','utf8'));setInterval(()=>{},1000)"
            def run(*args):
                return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout.strip()
            try:
                run('docker', 'create', '--name', name, '--network', 'none', '--read-only',
                    '--user', '1000:1000', '--mount', f'type=bind,src={config},dst=/runtime.json,readonly',
                    '--entrypoint', 'node', image, '-e', command)
                run('docker', 'start', name)
                d.replace_checked(config, b'first', b'second')
                run('docker', 'restart', '--time', '2', name)
                import time
                for _ in range(40):
                    if 'second' in run('docker', 'logs', name).splitlines():
                        break
                    time.sleep(0.1)
                else:
                    self.fail('Restart did not remount atomically replaced runtime configuration')
            finally:
                subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)


if __name__ == '__main__':
    unittest.main()
