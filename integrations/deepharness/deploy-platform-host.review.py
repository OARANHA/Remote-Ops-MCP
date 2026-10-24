#!/usr/bin/env python3
"""Operator-only activation of the existing DSH host. No business calls/grants."""
import copy
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time

WEB = 'deepharness-web-1'
RELAY = 'wandora-dsh-relay-lab-canary'
IMAGE = 'ghcr.io/oaranha/remote-ops-mcp-dsh-platform-candidate@sha256:8e0df65cb817fa11b2fd17ecdad6d5df75bf38bb97725a369cb501143b3a71a7'
REVIEWED_REVISION = '7ebc3fe11f125f3975b71a8f1949e853480bc2f8'
CONFIG = pathlib.Path('/opt/wandora/data/deepharness-mcp/review/runtime.json')
BACKUP = pathlib.Path('/opt/wandora/dsh-platform-host-activation-20261022-v1')
WORKSPACE_PARENT = '/data/dsh/projetos'
REPLAY_PARENT = '/data/dsh/wandora-platform-admin'
REPLAY_FILE = REPLAY_PARENT + '/replay.json'
ACTIONS = ['workspace.list', 'workspace.create', 'workspace.rename', 'session.list',
           'session.create', 'team.member.create', 'team.task.create', 'team.task.update']
PIN = re.compile(r'(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}')


def require(value):
    if not value:
        raise RuntimeError('host_activation_precondition_denied')


def run(*args, timeout=35):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('operator_command_failed')
    return result.stdout.strip()


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]

def installed_reviewed_host_image(web):
    require(web['State']['Running'] and web['Config']['User'] == '1000:1000')
    require(web['Config']['Image'] == IMAGE)
    require(web['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == REVIEWED_REVISION)
    image_id = web.get('Image')
    require(isinstance(image_id, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id))
    return image_id


def candidate_config(original, fingerprint):
    require(isinstance(original, dict) and PIN.fullmatch(fingerprint))
    bridge = original.get('semanticBridge') or {}
    require(bridge.get('enabled') is True and
            str(bridge.get('clientFingerprintSha256', '')).lower() == fingerprint.lower())
    require(original.get('platformAdmin') in (None, {'enabled': False}))
    candidate = copy.deepcopy(original)
    candidate['platformAdmin'] = {
        'enabled': True, 'workspaceParent': WORKSPACE_PARENT, 'replayFile': REPLAY_FILE,
        'allowedActions': list(ACTIONS), 'clientFingerprintSha256': fingerprint,
        'exclusiveReplayWriter': True,
    }
    return candidate


def replace_checked(path, expected, replacement):
    require(path.read_bytes() == expected)
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and not path.is_symlink() and metadata.st_nlink == 1)
    fd, temporary = tempfile.mkstemp(prefix='.dsh-platform-runtime-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
        require(path.read_bytes() == expected)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def activate_with_rollback(path, original, candidate, restart):
    try:
        replace_checked(path, original, candidate)
        restart()
    except BaseException:
        current = path.read_bytes()
        if current == candidate:
            replace_checked(path, candidate, original)
            restart()
            print('HOST_CONFIG_ROLLBACK=GREEN', flush=True)
        elif current != original:
            raise RuntimeError('concurrent_runtime_change_manual_recovery_required')
        raise


def wait_host(container_id):
    for _ in range(60):
        current = inspect(container_id)
        if current['State']['Running']:
            result = subprocess.run(
                ['docker', 'logs', '--since', current['State']['StartedAt'], '--tail', '150', container_id],
                capture_output=True, text=True, timeout=20)
            logs = result.stdout + result.stderr
            if result.returncode == 0 and 'OPERATIONAL_MCP_HOST_READY' in logs:
                snapshots = []
                for line in logs.splitlines():
                    try:
                        value = json.loads(line)
                        if isinstance(value, dict) and value.get('event') == 'DSH_PLATFORM_HOST_READINESS':
                            snapshots.append(value)
                    except ValueError:
                        pass
                if snapshots and snapshots[-1].get('ready') is True:
                    return
        time.sleep(0.5)
    raise RuntimeError('host_startup_not_verified')


def main():
    require(sys.argv[1:] == ['--apply'])
    require(os.geteuid() == 0 and socket.gethostname() == '28server')
    web, relay = inspect(WEB), inspect(RELAY)
    installed_image = installed_reviewed_host_image(web)
    require(web['HostConfig']['AutoRemove'] is False)
    require(relay['State']['Running'])
    env = dict(v.split('=', 1) for v in relay['Config'].get('Env', []) if '=' in v)
    require(env.get('DSH_PLATFORM_RELAY_ENABLED') == '1')
    mounts = {m['Destination']: m for m in web['Mounts']}
    require(mounts['/etc/wandora-mcp/runtime.json']['Source'] == str(CONFIG)
            and mounts['/etc/wandora-mcp/runtime.json']['RW'] is False)
    data = mounts['/data/dsh']
    require(data['Type'] == 'volume' and data['Name'] == 'deepharness_dsh_data_lab7' and data['RW'])
    data_root = pathlib.Path(data['Source'])
    projects = data_root / 'projetos'
    project_stat = projects.lstat()
    require(stat.S_ISDIR(project_stat.st_mode) and not projects.is_symlink()
            and project_stat.st_uid == 1000 and project_stat.st_gid == 1000)
    replay_dir = data_root / 'wandora-platform-admin'
    require(not replay_dir.exists() and not replay_dir.is_symlink())
    require(not BACKUP.exists() and not BACKUP.is_symlink())
    require(CONFIG.is_file() and not CONFIG.is_symlink())
    original = CONFIG.read_bytes()
    cert_destination = '/run/secrets/dsh-bridge-client-cert.pem'
    certs = [m for m in relay['Mounts'] if m['Destination'] == cert_destination]
    require(len(certs) == 1 and not certs[0]['RW'] and certs[0]['Type'] == 'bind')
    fingerprint = run('openssl', 'x509', '-in', certs[0]['Source'], '-noout', '-fingerprint', '-sha256').split('=', 1)[-1]
    candidate = (json.dumps(candidate_config(json.loads(original), fingerprint), indent=2) + '\n').encode()
    BACKUP.mkdir(mode=0o700)
    os.chmod(BACKUP, 0o700)
    snapshot = BACKUP / 'original-runtime.json'
    snapshot.write_bytes(original)
    snapshot.chmod(0o600)
    validation = BACKUP / 'candidate-runtime.json'
    validation.write_bytes(candidate)
    os.chown(validation, 1000, 1000)
    validation.chmod(0o400)
    # Import the validator FROM THE INSTALLED IMAGE with no network, secrets or services.
    run('docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
        '--mount', f'type=bind,src={validation},dst=/candidate-runtime.json,readonly',
        '--entrypoint', 'node', installed_image, '--input-type=module', '-e',
        "import {readFileSync} from 'node:fs';import {validateOperationalHostConfig} from '/opt/wandora-mcp-verifier/mcp/operational-host.mjs';validateOperationalHostConfig(JSON.parse(readFileSync('/candidate-runtime.json','utf8')));console.log('VALIDATED')")
    print('INSTALLED_HOST_CONFIG_VALIDATION=GREEN', flush=True)
    replay_dir.mkdir(mode=0o700)
    os.chown(replay_dir, 1000, 1000)
    os.chmod(replay_dir, 0o700)

    def restart():
        run('docker', 'restart', '--time', '25', web['Id'], timeout=90)
        wait_host(web['Id'])
        if CONFIG.read_bytes() == candidate:
            replay = replay_dir / 'replay.json'
            metadata = replay.lstat()
            require(stat.S_ISREG(metadata.st_mode) and not replay.is_symlink()
                    and metadata.st_uid == 1000 and stat.S_IMODE(metadata.st_mode) == 0o600)
            state = json.loads(replay.read_bytes())
            require(state == {'version': 1, 'receipts': {}})

    activate_with_rollback(CONFIG, original, candidate, restart)
    print('HOST_PLATFORM_CONFIG=ENABLED\nHOST_READINESS=GREEN\nHOST_PRIVATE_REPLAY_CREATED=GREEN')
    print('NO_BUSINESS_OPERATION_EXECUTED\nAGENT_TARGET_AND_OAUTH_GRANTS=NOT_ACTIVATED')
    print('HOST_CONFIG_BACKUP=' + str(snapshot))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        trace, lines = error.__traceback__, []
        while trace is not None:
            if trace.tb_frame.f_code.co_filename == __file__:
                lines.append(str(trace.tb_lineno))
            trace = trace.tb_next
        print('HOST_PLATFORM_ACTIVATION=STOPPED; error_type=' + type(error).__name__
              + '; script_lines=' + ','.join(lines) + '; do not retry', file=sys.stderr)
        sys.exit(1)
