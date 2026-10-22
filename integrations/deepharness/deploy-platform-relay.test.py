"""Offline fault-injection checks; does not claim a real Docker rollout."""
import contextlib
import copy
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
    def test_autoremove_rollout_failure_restores_prepared_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            olddir, newdir, bundle, quarantine = [root / x for x in ('old', 'new', 'bundle', 'quarantine')]
            olddir.mkdir()
            (olddir / 'bridge.sock').write_text('v1')
            original = {
                'Id': 'original', 'Image': d.IMAGE, 'State': {'Running': True},
                'Config': {'User': '995:985', 'Env': [
                    'DSH_UNIX_RELAY_ENABLED=1', 'DSH_UNIX_RELAY_SOCKET_GID=987',
                    'DSH_UNIX_RELAY_WORKSPACE_ID=fc24d43c-caf3-4059-8d82-5e9edd3c04c8',
                    'DSH_UNIX_RELAY_LEAD_SESSION_ID=session-83cba7de-20a3-447b-967a-36315132db1a',
                    'DSH_BRIDGE_SERVER_FP_SHA256=' + ':'.join(['ab'] * 32),
                ]},
                'HostConfig': {'AutoRemove': True, 'ReadonlyRootfs': True, 'GroupAdd': ['987'], 'PortBindings': {},
                               'Privileged': False, 'RestartPolicy': {'Name': 'no'}},
                'NetworkSettings': {'Networks': {'deepharness_mcp-private': {}}},
                'Mounts': [{'Destination': str(olddir), 'Source': str(olddir), 'RW': True, 'Type': 'bind'}],
            }
            events = []
            containers = {'original': original}

            def engine(method, path, body=None):
                events.append(('engine', method))
                if method == 'GET':
                    return original
                clone = copy.deepcopy(original)
                clone.update(Id='recovery', State={'Running': False, 'Status': 'created'})
                clone['HostConfig']['AutoRemove'] = False
                containers['recovery'] = clone
                return {'Id': 'recovery'}

            def command(*args, **kwargs):
                events.append(args)
                if args[:2] == ('docker', 'inspect'):
                    key = 'original' if args[2] == d.NAME else args[2]
                    return json.dumps([containers[key]])
                if args[:2] == ('docker', 'ps'):
                    return ''
                if args[:2] == ('docker', 'stop'):
                    key = args[-1]
                    containers[key]['State']['Running'] = False
                    if key == 'original':
                        self.assertIn('recovery', containers)
                        self.assertFalse(containers['recovery']['State']['Running'])
                        del containers['original']  # Docker AutoRemove semantics.
                    return ''
                if args[:2] == ('docker', 'create'):
                    containers['candidate'] = {'State': {'Running': False}}
                    return 'candidate'
                if args[:2] == ('docker', 'start'):
                    key = args[2]
                    containers[key]['State']['Running'] = key == 'recovery'
                    if key == 'recovery':
                        (olddir / 'bridge.sock').write_text('restored')
                    return ''
                return ''

            with contextlib.ExitStack() as stack:
                for key, value in {'OLD': olddir, 'NEW': newdir, 'ROOT': bundle,
                                   'QUARANTINE': quarantine, 'FILES': {},
                                   'MOUNTS': {str(olddir): (str(olddir), True)}}.items():
                    stack.enter_context(patch.object(d, key, value))
                stack.enter_context(patch.object(d, 'run', command))
                stack.enter_context(patch.object(d, 'engine_request', engine))
                stack.enter_context(patch.object(d, 'verify_dir'))
                stack.enter_context(patch.object(d, 'verify_socket', return_value=True))
                stack.enter_context(patch.object(d.os, 'chown'))
                stack.enter_context(patch.object(d.os, 'geteuid', return_value=0))
                stack.enter_context(patch.object(d.socket, 'gethostname', return_value='28server'))
                stack.enter_context(patch.object(d.sys, 'argv', ['deploy.py', '--apply']))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                with self.assertRaises(RuntimeError):
                    d.main()
            self.assertNotIn('original', containers)
            self.assertTrue(containers['recovery']['State']['Running'])
            self.assertIn(('docker', 'rename', 'recovery', d.NAME), events)
            self.assertIn('V1_ROLLBACK=GREEN', output.getvalue())
            self.assertLess(events.index(('engine', 'POST')), events.index(('docker', 'stop', '--time', '15', 'original')))

    def test_autoremove_backup_preserves_configuration_without_starting(self):
        old = {
            'Id': 'original', 'Image': 'sha256:image',
            'Config': {'Image': 'sha256:image', 'Env': ['PRIVATE=value'], 'Cmd': ['run']},
            'HostConfig': {'AutoRemove': True, 'ReadonlyRootfs': True, 'NetworkMode': 'private'},
            'Mounts': [{'Destination': '/socket', 'Source': '/socket', 'RW': True, 'Type': 'bind'}],
        }
        clone = json.loads(json.dumps(old))
        clone.update(Id='recovery', State={'Running': False, 'Status': 'created'})
        clone['HostConfig']['AutoRemove'] = False
        requests = []

        def engine(method, path, body=None):
            requests.append((method, path, body))
            if method == 'GET':
                return old
            self.assertTrue(old['HostConfig']['AutoRemove'])
            self.assertFalse(body['HostConfig']['AutoRemove'])
            self.assertEqual(body['Env'], old['Config']['Env'])
            return {'Id': 'recovery'}

        with patch.object(d, 'engine_request', engine, create=True), patch.object(d, 'run', return_value=json.dumps([clone])) as command:
            self.assertEqual(d.prepare_autoremove_backup(old), 'recovery')
        self.assertEqual([x[0] for x in requests], ['GET', 'POST'])
        self.assertEqual(command.call_args.args, ('docker', 'inspect', 'recovery'))
        self.assertTrue(old['HostConfig']['AutoRemove'])

    def test_autoremove_backup_mismatch_aborts_before_stopping_original(self):
        old = {'Id': 'original', 'Image': 'image', 'Config': {},
               'HostConfig': {'AutoRemove': True, 'ReadonlyRootfs': True}, 'Mounts': []}
        wrong = dict(old, Id='recovery', State={'Running': False, 'Status': 'created'})
        with patch.object(d, 'engine_request', side_effect=[old, {'Id': 'recovery'}], create=True), patch.object(d, 'run', return_value=json.dumps([wrong])) as command:
            with self.assertRaises(RuntimeError):
                d.prepare_autoremove_backup(old)
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[:2], ('docker', 'inspect'))

    def test_changed_writable_layer_denies_backup_before_creation(self):
        old = {'Id': 'original', 'HostConfig': {'AutoRemove': True}}
        with patch.object(d, 'run', return_value='C /app/code'), patch.object(d, 'engine_request') as engine:
            with self.assertRaises(RuntimeError):
                d.prepare_autoremove_backup(old)
        engine.assert_not_called()

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

