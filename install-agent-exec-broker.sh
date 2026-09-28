#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${WANDORA_AGENT_DIR:-/opt/wandora/remote-ops-agent}"
WORKSPACE="${WANDORA_AGENT_WORKSPACE:-/opt/wandora/ops-workspace}"
STATE_DIR="${WANDORA_AGENT_STATE_DIR:-/var/lib/wandora-ops-agent}"
EXEC_USER="${WANDORA_EXEC_USER:-wandora-exec}"
EXEC_GROUP="${WANDORA_EXEC_GROUP:-ops-mcp}"
BROKER_SERVICE_NAME="wandora-ops-exec-broker.service"
BROKER_SERVICE_FILE="/etc/systemd/system/$BROKER_SERVICE_NAME"
EXEC_SOCKET="${WANDORA_EXEC_BROKER_SOCKET:-/run/wandora-ops-exec/exec.sock}"
EXEC_PROGRAMS="${WANDORA_EXEC_PROGRAMS:-bash,sh,git,node,npm,npx,pnpm,python3,curl,wget,jq,grep,sed,awk,find,head,tail,cat,wc,make}"

log() { printf '\033[1;34m[wandora-exec]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"
test -f "$INSTALL_DIR/dist/exec/broker.js" || die "missing $INSTALL_DIR/dist/exec/broker.js"
getent group "$EXEC_GROUP" >/dev/null 2>&1 || die "group $EXEC_GROUP does not exist"

if ! id "$EXEC_USER" >/dev/null 2>&1; then
  log "Creating isolated execution user $EXEC_USER..."
  useradd     --system     --create-home     --home-dir /var/lib/wandora-exec     --shell /usr/sbin/nologin     "$EXEC_USER"
fi

if id -nG "$EXEC_USER" | grep -Eq '(^| )(sudo|docker|wandora-ops)( |$)'; then
  die "$EXEC_USER must not belong to privileged groups"
fi

install -d -o "$EXEC_USER" -g "$EXEC_GROUP" -m 0770 "$WORKSPACE"

cat >"$BROKER_SERVICE_FILE" <<UNIT
[Unit]
Description=Wandora isolated execution broker
After=network.target
Before=wandora-ops-agent.service

[Service]
Type=simple
User=$EXEC_USER
Group=$EXEC_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/dist/exec/broker.js
Restart=on-failure
RestartSec=2
RuntimeDirectory=wandora-ops-exec
RuntimeDirectoryMode=0750
Environment=WANDORA_EXEC_BROKER_SOCKET=$EXEC_SOCKET
Environment=WANDORA_EXEC_ROOTS=$WORKSPACE
Environment=WANDORA_EXEC_PROGRAMS=$EXEC_PROGRAMS
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
TasksMax=128
MemoryMax=1G
CPUQuota=200%
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$WORKSPACE /run/wandora-ops-exec
InaccessiblePaths=$STATE_DIR /root /home /etc/ssh /etc/ssl/private -/var/run/docker.sock
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "$BROKER_SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$BROKER_SERVICE_NAME" >/dev/null
systemctl restart "$BROKER_SERVICE_NAME"

for _ in $(seq 1 40); do
  [[ -S "$EXEC_SOCKET" ]] && systemctl is-active --quiet "$BROKER_SERVICE_NAME" && break
  sleep 0.25
done

systemctl is-active --quiet "$BROKER_SERVICE_NAME"   || { journalctl -u "$BROKER_SERVICE_NAME" -n 80 --no-pager >&2 || true; die "execution broker failed to start"; }
[[ -S "$EXEC_SOCKET" ]] || die "execution broker socket missing: $EXEC_SOCKET"

ok "Execution broker is active"
printf 'broker=%s\n' "$BROKER_SERVICE_NAME"
printf 'workspace=%s\n' "$WORKSPACE"
printf 'socket=%s\n' "$EXEC_SOCKET"
