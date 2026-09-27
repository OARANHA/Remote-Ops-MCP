#!/usr/bin/env bash
set -Eeuo pipefail

CONTROL_PLANE="${WANDORA_CONTROL_PLANE:-https://mcp.wandora.com.br}"
INSTALL_DIR="${WANDORA_AGENT_DIR:-/opt/wandora/remote-ops-agent}"
STATE_FILE="${WANDORA_AGENT_STATE:-/var/lib/wandora-ops-agent/device.json}"
SERVICE_NAME="wandora-ops-admin-broker.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
SOCKET="${WANDORA_ADMIN_BROKER_SOCKET:-/run/wandora-ops-admin/admin.sock}"
ADMIN_STATE_DIR="${WANDORA_ADMIN_STATE_DIR:-/var/lib/wandora-ops-admin}"
PUBLIC_KEY_DIR="${WANDORA_ADMIN_PUBLIC_KEY_DIR:-/etc/wandora}"
PUBLIC_KEY_FILE="${WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY:-$PUBLIC_KEY_DIR/managed-admin-public.pem}"
PUBLIC_KEY_URL="${WANDORA_ADMIN_PUBLIC_KEY_URL:-${CONTROL_PLANE%/}/agent/managed-admin-public-key}"
ADMIN_CWDS="${WANDORA_ADMIN_CWDS:-/opt/wandora/ops-workspace,/opt/wandora}"
ADMIN_PROGRAMS="${WANDORA_ADMIN_PROGRAMS:-apt-get,apt,dpkg,systemctl,journalctl,docker,git,curl,wget,install,cp,mv,rm,rmdir,mkdir,chmod,chown,chgrp,ln,tar,unzip,ufw,firewall-cmd,ip,ss,hostnamectl,timedatectl,sysctl,mount,umount,lsblk,df,du}"

log(){ printf '\033[1;34m[wandora-managed-admin]\033[0m %s\n' "$*"; }
ok(){ printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"
[[ "$CONTROL_PLANE" =~ ^https:// ]] || die "managed-admin requires an https control plane"
getent group ops-mcp >/dev/null 2>&1 || die "ops-mcp group does not exist; install/pair the agent first"
test -s "$STATE_FILE" || die "paired agent state missing: $STATE_FILE"
test -f "$INSTALL_DIR/dist/privileged/managed-admin-broker.js" || die "missing managed admin broker build in $INSTALL_DIR"

device_id="$(/usr/bin/node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s.device_id||""));' "$STATE_FILE")"
[[ "$device_id" =~ ^dev_[A-Za-z0-9_-]{8,80}$ ]] || die "invalid paired device_id"

install -d -o root -g root -m 0700 "$ADMIN_STATE_DIR"
install -d -o root -g root -m 0755 "$PUBLIC_KEY_DIR"

tmp_key="$(mktemp)"
trap 'rm -f "$tmp_key"' EXIT
log "Fetching managed-admin public verification key..."
curl -fsSL --proto '=https' --tlsv1.2 "$PUBLIC_KEY_URL" -o "$tmp_key"
grep -q '^-----BEGIN PUBLIC KEY-----$' "$tmp_key" || die "control plane did not return a PEM public key"
grep -q '^-----END PUBLIC KEY-----$' "$tmp_key" || die "control plane returned an incomplete public key"
install -o root -g root -m 0644 "$tmp_key" "$PUBLIC_KEY_FILE"

if [[ -f "$SERVICE_FILE" ]]; then
  cp -a "$SERVICE_FILE" "$SERVICE_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
fi

cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=Wandora managed admin root broker
After=network-online.target wandora-ops-agent.service
Wants=network-online.target
Requires=wandora-ops-agent.service

[Service]
Type=simple
User=root
Group=ops-mcp
WorkingDirectory=$INSTALL_DIR
Environment=WANDORA_ADMIN_BROKER_SOCKET=$SOCKET
Environment=WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY=$PUBLIC_KEY_FILE
Environment=WANDORA_AGENT_STATE=$STATE_FILE
Environment=WANDORA_ADMIN_REPLAY_FILE=$ADMIN_STATE_DIR/replay.json
Environment=WANDORA_ADMIN_CWDS=$ADMIN_CWDS
Environment=WANDORA_ADMIN_PROGRAMS=$ADMIN_PROGRAMS
ExecStart=/usr/bin/node $INSTALL_DIR/dist/privileged/managed-admin-broker.js
Restart=on-failure
RestartSec=2
RuntimeDirectory=wandora-ops-admin
RuntimeDirectoryMode=0750
StateDirectory=wandora-ops-admin
StateDirectoryMode=0700
NoNewPrivileges=yes
PrivateTmp=yes
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

for _ in $(seq 1 40); do
  if systemctl is-active --quiet "$SERVICE_NAME" && [[ -S "$SOCKET" ]]; then break; fi
  sleep 0.25
done
systemctl is-active --quiet "$SERVICE_NAME" || { journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true; die "managed admin broker failed"; }
[[ -S "$SOCKET" ]] || die "managed admin broker socket missing"
[[ "$(stat -c '%G:%a' "$SOCKET")" == "ops-mcp:660" ]] || die "managed admin socket permissions are not ops-mcp:660"
[[ "$(stat -c '%G:%a' /run/wandora-ops-admin)" == "ops-mcp:750" ]] || die "managed admin runtime directory permissions are not ops-mcp:750"
systemctl restart wandora-ops-agent.service
systemctl is-active --quiet wandora-ops-agent.service || die "agent failed after managed-admin broker activation"

ok "Managed admin broker is active"
printf 'MANAGED_ADMIN_BROKER=READY\n'
printf 'device_id=%s\n' "$device_id"
printf 'service=%s\n' "$SERVICE_NAME"
printf 'socket=%s\n' "$SOCKET"
printf 'public_key=%s\n' "$PUBLIC_KEY_FILE"
printf 'admin_cwds=%s\n' "$ADMIN_CWDS"
