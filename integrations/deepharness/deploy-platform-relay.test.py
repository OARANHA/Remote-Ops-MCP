"""Offline fault-injection checks; does not claim a real Docker rollout."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', pathlib.Path(__file__).with_name('deploy-platform-relay.review.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class RecoveryTests(unittest.TestCase):
    def test_quarantine_moves_symlink_without_following_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source, private = root / 'source', root / 'private'
            source.mkdir()
            private.mkdir()
            victim = root / 'unrelated'
            victim.write_text('preserve')
            (source / 'bridge.sock').symlink_to(victim)
            d.quarantine_endpoint(source, private, 'failed-entry')
            self.assertTrue((private / 'failed-entry').is_symlink())
            self.assertEqual(victim.read_text(), 'preserve')
            self.assertFalse((source / 'bridge.sock').is_symlink())

    def test_rollback_stops_candidate_before_handling_invalid_endpoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            old, new, private = [root / p for p in ('old', 'new', 'private')]
            for folder in (old, new, private):
                folder.mkdir()
            (old / 'bridge.sock').write_text('bad candidate V1 endpoint')
            (new / 'bridge.sock').mkdir()  # Deliberately not a valid socket.
            events = []
            state = {'candidate': True, 'original': False}

            def command(*args, **kwargs):
                events.append(args)
                if args[:2] == ('docker', 'stop'):
                    state['candidate'] = False
                elif args[:2] == ('docker', 'inspect'):
                    return json.dumps([{'State': {'Running': state[args[2]]}}])
                elif args[:2] == ('docker', 'rm'):
                    self.assertFalse(state['candidate'])
                elif args[:2] == ('docker', 'start'):
                    self.assertFalse(state['candidate'])
                    self.assertFalse((old / 'bridge.sock').exists())
                    state['original'] = True
                    (old / 'bridge.sock').write_text('restored')
                return ''

            def verify(p):
                self.assertFalse(state['candidate'])
                return p.read_text() == 'restored'

            with patch.object(d, 'OLD', old), patch.object(d, 'NEW', new), patch.object(d, 'run', command), patch.object(d, 'verify_socket', verify), contextlib.redirect_stdout(io.StringIO()) as out:
                d.restore_v1('original', 'candidate', True, private)
            self.assertTrue(state['original'])
            self.assertEqual(events[0], ('docker', 'stop', '--time', '15', 'candidate'))
            self.assertTrue((private / 'candidate-v2-endpoint').is_dir())
            self.assertEqual((private / 'candidate-v1-endpoint').read_text(), 'bad candidate V1 endpoint')
            self.assertIn('V1_ROLLBACK=GREEN', out.getvalue())

    def test_cross_device_quarantine_is_denied_before_moving_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source, private = root / 'source', root / 'private'
            source.mkdir()
            private.mkdir()
            (source / 'bridge.sock').write_text('keep')
            class Device:
                def __init__(self, dev):
                    self.st_dev = dev
            with patch.object(d.os, 'fstat', side_effect=[Device(1), Device(2)]):
                with self.assertRaises(RuntimeError):
                    d.quarantine_endpoint(source, private, 'cross-device')
            self.assertEqual((source / 'bridge.sock').read_text(), 'keep')

    def test_quarantine_of_absent_endpoint_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source, private = root / 'source', root / 'private'
            source.mkdir()
            private.mkdir()
            d.quarantine_endpoint(source, private, 'missing')
            self.assertEqual(list(private.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
