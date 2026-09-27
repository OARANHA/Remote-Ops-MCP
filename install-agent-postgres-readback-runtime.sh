#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${WANDORA_POSTGRES_READBACK_SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
INSTALL_DIR="${WANDORA_AGENT_DIR:-/opt/wandora/remote-ops-agent}"
SERVICE_NAME="${WANDORA_AGENT_SERVICE:-wandora-ops-agent.service}"
SYSTEMCTL_BIN="${WANDORA_SYSTEMCTL:-systemctl}"
BACKUP_ROOT="${WANDORA_POSTGRES_READBACK_BACKUP_ROOT:-/opt/wandora}"
EXPECTED_REVISION="${WANDORA_EXPECTED_REVISION:-}"

FILES=(
  "dist/agent/operations.js"
  "dist/docker/read-proxy.js"
  "dist/docker/postgres-readback.js"
)

log(){ printf '[wandora-postgres-runtime] %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"
[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]] || die "WANDORA_EXPECTED_REVISION must be an exact 40-char lowercase git SHA"
[[ -d "$SOURCE_DIR/.git" ]] || die "source checkout missing .git: $SOURCE_DIR"
[[ -d "$INSTALL_DIR/dist/agent" && -d "$INSTALL_DIR/dist/docker" ]] || die "agent install dir missing: $INSTALL_DIR"
[[ -x "$SYSTEMCTL_BIN" || "$SYSTEMCTL_BIN" == "systemctl" ]] || die "systemctl command not executable: $SYSTEMCTL_BIN"

SOURCE_REVISION="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[[ "$SOURCE_REVISION" == "$EXPECTED_REVISION" ]] || die "source revision mismatch: expected $EXPECTED_REVISION got $SOURCE_REVISION"

for rel in "${FILES[@]}"; do
  [[ -f "$SOURCE_DIR/$rel" ]] || die "required staged artifact missing: $SOURCE_DIR/$rel"
done
[[ -f "$INSTALL_DIR/dist/agent/operations.js" ]] || die "existing agent operations.js missing"
[[ -f "$INSTALL_DIR/dist/docker/read-proxy.js" ]] || die "existing read-proxy.js missing"
"$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME is not active before patch"

declare -A SOURCE_HASHES=()
for rel in "${FILES[@]}"; do
  read -r hash _ < <(sha256sum "$SOURCE_DIR/$rel")
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || die "unable to hash $rel"
  SOURCE_HASHES["$rel"]="$hash"
done

ts="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/remote-ops-agent.rollback-postgres-readback-$ts"
install -d -m 0750 "$BACKUP_DIR"

for rel in "${FILES[@]}"; do
  install -d -m 0750 "$BACKUP_DIR/$(dirname "$rel")"
  marker="$BACKUP_DIR/${rel//\//__}.absent"
  if [[ -f "$INSTALL_DIR/$rel" ]]; then
    cp -a "$INSTALL_DIR/$rel" "$BACKUP_DIR/$rel"
  else
    : >"$marker"
  fi
done
printf '%s\n' "$SOURCE_REVISION" >"$BACKUP_DIR/source-revision.txt"

rollback(){
  local rc=$?
  (( rc != 0 )) || rc=1
  trap - ERR INT TERM
  set +e
  log "patch failed; restoring previous agent artifacts"
  for rel in "${FILES[@]}"; do
    marker="$BACKUP_DIR/${rel//\//__}.absent"
    if [[ -f "$BACKUP_DIR/$rel" ]]; then
      install -D -o root -g root -m 0644 "$BACKUP_DIR/$rel" "$INSTALL_DIR/$rel"
    elif [[ -f "$marker" ]]; then
      rm -f "$INSTALL_DIR/$rel"
    fi
  done
  "$SYSTEMCTL_BIN" restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  exit "$rc"
}
trap rollback ERR INT TERM

log "stopping $SERVICE_NAME"
"$SYSTEMCTL_BIN" stop "$SERVICE_NAME"

for rel in "${FILES[@]}"; do
  install -D -o root -g root -m 0644 "$SOURCE_DIR/$rel" "$INSTALL_DIR/$rel"
  read -r installed_hash _ < <(sha256sum "$INSTALL_DIR/$rel")
  [[ "$installed_hash" == "${SOURCE_HASHES[$rel]}" ]] || die "installed hash mismatch: $rel"
done

log "starting $SERVICE_NAME"
"$SYSTEMCTL_BIN" start "$SERVICE_NAME"
for _ in $(seq 1 20); do
  "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" && break
  sleep 0.5
done
"$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME failed after patch"

trap - ERR INT TERM
printf 'POSTGRES_READBACK_AGENT_RUNTIME=GREEN\n'
printf 'revision=%s\n' "$SOURCE_REVISION"
printf 'backup=%s\n' "$BACKUP_DIR"
printf 'broker_untouched=true\n'
printf 'pairing_untouched=true\n'
