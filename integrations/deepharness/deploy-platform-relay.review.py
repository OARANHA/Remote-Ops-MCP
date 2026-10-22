#!/usr/bin/env python3
"""Operator deployment on 28server only. Reuses the current V1 image/TLS.
No DSH business calls, host platform authority, OAuth grants or agent changes.
"""
import hashlib
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.request

REV = 'efb0b9d0cc22a0b11531732362fd44e8ee573804'
IMAGE = 'sha256:35582d3b80a56174086d229793ef8e99d2e39c773cc682d58a8f652283c306d2'
NAME = 'wandora-dsh-relay-lab-canary'
BACKUP = NAME + '-v1-backup-efb0b9d'
ROOT = pathlib.Path('/opt/wandora/dsh-platform-relay-efb0b9d')
OLD = pathlib.Path('/run/wandora/deepharness-semantic')
NEW = pathlib.Path('/run/wandora/deepharness-platform')
DEST = '/opt/wandora-dsh-relay'
QUARANTINE = pathlib.Path('/run/wandora/dsh-relay-rollback-efb0b9d')
FILES = {
 'private-bridge-client.mjs': '0bfccd671820a857f5850907e4e4105a0b445a8c8717490d8e361e81e99661b0',
 'agent-mesh-unix-relay.mjs': 'afb726baac589f2c45d422935c9d0574e9981d561756a228c0261b05a155f5ce',
 'agent-mesh-unix-listener.mjs': '428f7a3d2b40187982edc1483642e710221599e2ddfa20598e6f9ec9d98af2df',
 'agent-mesh-unix-relay-run.mjs': 'e8c7ad54d681acd45ad3583734c6fcab1bf27607c107637316048b49a1c76dfa',
 'platform-admin-contract.mjs': 'efaff362bbddf5aa8684675dc1e70b503bae14f0f335ba9178ff3e0ca400996c',
 'platform-admin-private-http-handler.mjs': '91f829a1901e07e07470ac37ee36555a9065d339820668de6197fafa2c28ad62',
}
MOUNTS = {
 '/run/secrets/dsh-bridge-ca.pem': ('/opt/wandora/data/deepharness-mcp/tls/backend/backend-ca.pem', False),
 '/run/secrets/dsh-bridge-client-cert.pem': ('/opt/wandora/dsh-relay-secrets/client-cert.pem', False),
 '/run/secrets/dsh-bridge-client-key.pem': ('/opt/wandora/dsh-relay-secrets/client-key.pem', False),
 str(OLD): (str(OLD), True),
}


def run(*args, timeout=55):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('command_failed')
    return p.stdout.strip()


def require(value):
    if not value:
        raise RuntimeError('precondition_denied')


def verify_dir(p):
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == 995 and s.st_gid == 987
            and stat.S_IMODE(s.st_mode) == 0o2710)


def verify_socket(p):
    s = p.lstat()
    return stat.S_ISSOCK(s.st_mode) and s.st_uid == 995 and s.st_gid == 987 and stat.S_IMODE(s.st_mode) == 0o660



def quarantine_endpoint(folder, private, label):
    # Candidate endpoints were absent before startup. Move (never follow/delete)
    # any entry it left, including an incorrectly typed socket or symlink.
    src = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    dst = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(os.fstat(src).st_dev == os.fstat(dst).st_dev)
        try:
            os.rename('bridge.sock', label, src_dir_fd=src, dst_dir_fd=dst)
        except FileNotFoundError:
            pass
    finally:
        os.close(src)
        os.close(dst)


def restore_v1(old_id, new_id, renamed, private):
    # Never validate a failing candidate's socket before stopping that writer.
    if new_id is not None:
        run('docker', 'stop', '--time', '15', new_id)
        require(not json.loads(run('docker', 'inspect', new_id))[0]['State']['Running'])
        run('docker', 'rm', new_id)
        for label, folder in (('candidate-v1-endpoint', OLD), ('candidate-v2-endpoint', NEW)):
            quarantine_endpoint(folder, private, label)
    if renamed:
        run('docker', 'rename', old_id, NAME)
    run('docker', 'start', old_id)
    for _ in range(20):
        current = json.loads(run('docker', 'inspect', old_id))[0]
        try:
            if current['State']['Running'] and verify_socket(OLD / 'bridge.sock'):
                print('V1_ROLLBACK=GREEN', flush=True)
                return
        except FileNotFoundError:
            pass
        time.sleep(0.25)
    raise RuntimeError('v1_rollback_not_verified')


def main():
    require(sys.argv[1:] == ['--apply'])
    require(os.geteuid() == 0 and socket.gethostname() == '28server')
    old = json.loads(run('docker', 'inspect', NAME))[0]
    require(old['State']['Running'] and not old['HostConfig']['AutoRemove'])
    require(old['Image'] == IMAGE and old['Config']['User'] == '995:985')
    require(old['HostConfig'].get('GroupAdd') == ['987'])
    require(set(old['NetworkSettings']['Networks']) == {'deepharness_mcp-private'})
    require(old['HostConfig'].get('PortBindings') in (None, {}))
    require(not old['HostConfig'].get('Privileged'))
    actual = {m['Destination']: (m['Source'], m['RW']) for m in old['Mounts']}
    require(actual == MOUNTS and all(m['Type'] == 'bind' for m in old['Mounts']))
    env = dict(v.split('=', 1) for v in old['Config'].get('Env', []) if '=' in v)
    require(env.get('DSH_UNIX_RELAY_ENABLED') == '1')
    require(env.get('DSH_UNIX_RELAY_SOCKET_GID') == '987')
    require(env.get('DSH_UNIX_RELAY_WORKSPACE_ID') == 'fc24d43c-caf3-4059-8d82-5e9edd3c04c8')
    require(env.get('DSH_UNIX_RELAY_LEAD_SESSION_ID') == 'session-83cba7de-20a3-447b-967a-36315132db1a')
    require(re.fullmatch(r'(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}', env.get('DSH_BRIDGE_SERVER_FP_SHA256', '')))
    require(env.get('DSH_PLATFORM_RELAY_ENABLED') != '1')
    require(all('\n' not in k + v and '\r' not in k + v for k, v in env.items()))
    require(not ROOT.exists() and not ROOT.is_symlink())
    require(not NEW.exists() and not NEW.is_symlink())
    require(not QUARANTINE.exists() and not QUARANTINE.is_symlink())
    # Exact-name collision test, no fallback to a different container.
    require(not run('docker', 'ps', '-aq', '--filter', 'name=^/' + BACKUP + '$'))
    verify_dir(OLD)
    require(verify_socket(OLD / 'bridge.sock'))
    ROOT.mkdir(mode=0o755)
    os.chmod(ROOT, 0o755)
    private = ROOT / 'rollback-private'
    private.mkdir(mode=0o700)
    os.chmod(private, 0o700)
    (private / 'original-inspect.json').write_text(json.dumps(old))
    os.chmod(private / 'original-inspect.json', 0o600)
    code = ROOT / 'code'
    code.mkdir(mode=0o755)
    os.chmod(code, 0o755)
    for name, expected in FILES.items():
        url = f'https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/{REV}/integrations/deepharness/{name}'
        with urllib.request.urlopen(url, timeout=20) as response:
            data = response.read(262145)
        require(len(data) <= 262144 and hashlib.sha256(data).hexdigest() == expected)
        (code / name).write_bytes(data)
        os.chmod(code / name, 0o444)
    run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', '995:985',
        '--mount', f'type=bind,src={code},dst={DEST},readonly', '--entrypoint', 'node',
        IMAGE, '--input-type=module', '-e',
        'await import("' + DEST + '/agent-mesh-unix-relay-run.mjs");console.log("IMPORT_OK")')
    print('PINNED_SOURCE_AND_NONROOT_IMPORT=GREEN', flush=True)
    NEW.mkdir(mode=0o2710)
    os.chown(NEW, 995, 987)
    os.chmod(NEW, 0o2710)
    verify_dir(NEW)
    QUARANTINE.mkdir(mode=0o700)
    os.chmod(QUARANTINE, 0o700)
    require(QUARANTINE.stat().st_dev == OLD.stat().st_dev == NEW.stat().st_dev)
    env.update(DSH_PLATFORM_RELAY_ENABLED='1', DSH_PLATFORM_SOCKET_GID='987')
    envfile = private / 'candidate.env'
    fd = os.open(envfile, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(''.join(k + '=' + v + '\n' for k, v in env.items()))
    cmd = ['docker', 'create', '--name', NAME, '--pull', 'never', '--init',
           '--network', 'deepharness_mcp-private', '--user', '995:985', '--group-add', '987',
           '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
           '--pids-limit', '64', '--memory', '192m', '--cpus', '0.5',
           '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
           '--env-file', str(envfile)]
    policy = old['HostConfig']['RestartPolicy']
    restart = policy['Name'] or 'no'
    if restart == 'on-failure' and policy.get('MaximumRetryCount'):
        restart += ':' + str(policy['MaximumRetryCount'])
    cmd += ['--restart', restart]
    for dst, (src, writable) in MOUNTS.items():
        cmd += ['--mount', f'type=bind,src={src},dst={dst}' + ('' if writable else ',readonly')]
    cmd += ['--mount', f'type=bind,src={NEW},dst={NEW}',
            '--mount', f'type=bind,src={code},dst={DEST},readonly',
            '--entrypoint', 'node', IMAGE, DEST + '/agent-mesh-unix-relay-run.mjs']
    original_inode = (OLD / 'bridge.sock').lstat().st_ino
    stopped = renamed = False
    new_id = None
    try:
        run('docker', 'stop', '--time', '15', old['Id'])
        stopped = True
        require(not json.loads(run('docker', 'inspect', old['Id']))[0]['State']['Running'])
        try:
            stale = (OLD / 'bridge.sock').lstat()
            require(stale.st_ino == original_inode and verify_socket(OLD / 'bridge.sock'))
            quarantine_endpoint(OLD, QUARANTINE, 'original-stale-v1-endpoint')
        except FileNotFoundError:
            pass
        run('docker', 'rename', old['Id'], BACKUP)
        renamed = True
        new_id = run(*cmd)
        run('docker', 'start', new_id)
        ready = False
        for _ in range(20):
            current = json.loads(run('docker', 'inspect', new_id))[0]
            if not current['State']['Running']:
                break
            try:
                ready = verify_socket(OLD / 'bridge.sock') and verify_socket(NEW / 'bridge.sock')
            except FileNotFoundError:
                ready = False
            if ready:
                break
            time.sleep(0.25)
        require(ready)
        logs = run('docker', 'logs', '--tail', '30', new_id)
        require('DSH_UNIX_RELAY_LISTENING' in logs and 'NOT_STARTED' not in logs)
    except BaseException:
        if stopped:
            restore_v1(old['Id'], new_id, renamed, QUARANTINE)
        raise
    print('RELAY_V1_SOCKET=GREEN\nRELAY_V2_SOCKET=GREEN\nV1_BACKUP=' + BACKUP)
    print('HOST_AUTHORITY_AGENT_TARGET_AND_OAUTH_GRANTS=NOT_ACTIVATED')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('RELAY_DEPLOYMENT=STOPPED; inspect local state before retry', file=sys.stderr)
        sys.exit(1)
