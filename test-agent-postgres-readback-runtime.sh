#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bash -n install-agent-postgres-readback-runtime.sh
command -v sudo >/dev/null 2>&1 || { echo 'sudo is required for runtime installer test' >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'sudo rm -rf "$TMP"' EXIT
HEAD_SHA="$(git rev-parse HEAD)"
FAKE_SYSTEMCTL="$TMP/fake-systemctl"

cat >"$FAKE_SYSTEMCTL" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
: "${FAKE_SYSTEMCTL_LOG:?}"
printf '%s %s\n' "$1" "${*:2}" >>"$FAKE_SYSTEMCTL_LOG"
case "$1" in
  is-active) exit 0 ;;
  stop) exit 0 ;;
  start)
    if [[ "${FAKE_FAIL_START:-0}" == "1" ]]; then
      marker="${FAKE_FAIL_MARKER:?}"
      if [[ ! -e "$marker" ]]; then
        : >"$marker"
        exit 1
      fi
    fi
    exit 0
    ;;
  restart) exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$FAKE_SYSTEMCTL"

make_agent_fixture(){
  local dir="$1"
  mkdir -p "$dir/dist/agent" "$dir/dist/docker" "$dir/dist/exec"
  printf 'old-operations\n' >"$dir/dist/agent/operations.js"
  printf 'old-read-proxy\n' >"$dir/dist/docker/read-proxy.js"
  printf 'broker-sentinel\n' >"$dir/dist/exec/broker.js"
}

SUCCESS_AGENT="$TMP/success-agent"
SUCCESS_BACKUPS="$TMP/success-backups"
SUCCESS_LOG="$TMP/success-systemctl.log"
make_agent_fixture "$SUCCESS_AGENT"

sudo env \
  WANDORA_POSTGRES_READBACK_SOURCE_DIR="$ROOT" \
  WANDORA_AGENT_DIR="$SUCCESS_AGENT" \
  WANDORA_AGENT_SERVICE="fake-agent.service" \
  WANDORA_SYSTEMCTL="$FAKE_SYSTEMCTL" \
  WANDORA_POSTGRES_READBACK_BACKUP_ROOT="$SUCCESS_BACKUPS" \
  WANDORA_EXPECTED_REVISION="$HEAD_SHA" \
  FAKE_SYSTEMCTL_LOG="$SUCCESS_LOG" \
  bash "$ROOT/install-agent-postgres-readback-runtime.sh"

cmp "$ROOT/dist/agent/operations.js" "$SUCCESS_AGENT/dist/agent/operations.js"
cmp "$ROOT/dist/docker/read-proxy.js" "$SUCCESS_AGENT/dist/docker/read-proxy.js"
cmp "$ROOT/dist/docker/postgres-readback.js" "$SUCCESS_AGENT/dist/docker/postgres-readback.js"
grep -qx 'broker-sentinel' "$SUCCESS_AGENT/dist/exec/broker.js"
grep -q '^stop fake-agent.service$' "$SUCCESS_LOG"
grep -q '^start fake-agent.service$' "$SUCCESS_LOG"
if grep -q '^restart fake-agent.service$' "$SUCCESS_LOG"; then
  echo 'success path unexpectedly restarted service via rollback' >&2
  exit 1
fi

SUCCESS_BACKUP="$(find "$SUCCESS_BACKUPS" -maxdepth 1 -type d -name 'remote-ops-agent.rollback-postgres-readback-*' | head -n1)"
[[ -n "$SUCCESS_BACKUP" ]]
sudo grep -qx 'old-operations' "$SUCCESS_BACKUP/dist/agent/operations.js"
sudo grep -qx 'old-read-proxy' "$SUCCESS_BACKUP/dist/docker/read-proxy.js"

ROLLBACK_AGENT="$TMP/rollback-agent"
ROLLBACK_BACKUPS="$TMP/rollback-backups"
ROLLBACK_LOG="$TMP/rollback-systemctl.log"
ROLLBACK_MARKER="$TMP/fail-start-once"
make_agent_fixture "$ROLLBACK_AGENT"
printf 'old-postgres-readback\n' >"$ROLLBACK_AGENT/dist/docker/postgres-readback.js"

set +e
sudo env \
  WANDORA_POSTGRES_READBACK_SOURCE_DIR="$ROOT" \
  WANDORA_AGENT_DIR="$ROLLBACK_AGENT" \
  WANDORA_AGENT_SERVICE="fake-agent.service" \
  WANDORA_SYSTEMCTL="$FAKE_SYSTEMCTL" \
  WANDORA_POSTGRES_READBACK_BACKUP_ROOT="$ROLLBACK_BACKUPS" \
  WANDORA_EXPECTED_REVISION="$HEAD_SHA" \
  FAKE_SYSTEMCTL_LOG="$ROLLBACK_LOG" \
  FAKE_FAIL_START=1 \
  FAKE_FAIL_MARKER="$ROLLBACK_MARKER" \
  bash "$ROOT/install-agent-postgres-readback-runtime.sh"
rc=$?
set -e

[[ "$rc" -ne 0 ]] || { echo 'rollback scenario unexpectedly succeeded' >&2; exit 1; }
grep -qx 'old-operations' "$ROLLBACK_AGENT/dist/agent/operations.js"
grep -qx 'old-read-proxy' "$ROLLBACK_AGENT/dist/docker/read-proxy.js"
grep -qx 'old-postgres-readback' "$ROLLBACK_AGENT/dist/docker/postgres-readback.js"
grep -qx 'broker-sentinel' "$ROLLBACK_AGENT/dist/exec/broker.js"
grep -q '^restart fake-agent.service$' "$ROLLBACK_LOG"

echo 'POSTGRES_READBACK_AGENT_RUNTIME_INSTALLER=GREEN'
