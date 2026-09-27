#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="wandora-ops-admin-broker.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
PUBLIC_KEY_FILE="${WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY:-/etc/wandora/managed-admin-public.pem}"
ADMIN_STATE_DIR="${WANDORA_ADMIN_STATE_DIR:-/var/lib/wandora-ops-admin}"
RUNTIME_DIR="/run/wandora-ops-admin"

die(){ printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ok(){ printf '\033[1;32m✓\033[0m %s\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"

systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
rm -f "$SERVICE_FILE"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true

rm -f "$PUBLIC_KEY_FILE"
rm -f "$ADMIN_STATE_DIR/replay.json"
rmdir "$ADMIN_STATE_DIR" >/dev/null 2>&1 || true
rm -rf "$RUNTIME_DIR"

ok "Managed-admin root broker removed"
printf 'MANAGED_ADMIN_BROKER=REMOVED\n'
printf 'pairing_preserved=true\n'
printf 'workspace_preserved=true\n'
printf 'exec_broker_preserved=true\n'
printf 'note=disable/revoke any managed-admin Target Registry entry in the control plane\n'
