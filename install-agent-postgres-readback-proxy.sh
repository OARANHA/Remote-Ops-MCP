#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${WANDORA_AGENT_DIR:-/opt/wandora/remote-ops-agent}"
SERVICE_NAME="wandora-ops-docker-read-proxy.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
AGENT_SERVICE="wandora-ops-agent.service"
DROPIN_DIR="/etc/systemd/system/$AGENT_SERVICE.d"
DROPIN_FILE="$DROPIN_DIR/docker-read-proxy.conf"
PORT="${WANDORA_POSTGRES_READBACK_PORT:-23751}"
CONTAINER="${WANDORA_POSTGRES_READBACK_CONTAINER:-}"
VERIFIERS="${WANDORA_POSTGRES_READBACK_VERIFIERS:-}"
EXEC_USER="${WANDORA_POSTGRES_READBACK_EXEC_USER:-postgres}"
DB_USER="${WANDORA_POSTGRES_READBACK_DB_USER:-postgres}"
DB_NAME="${WANDORA_POSTGRES_READBACK_DB_NAME:-postgres}"

log() { printf '\033[1;34m[wandora-postgres-readback]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "invalid port"
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "WANDORA_POSTGRES_READBACK_CONTAINER is required"
[[ -n "$VERIFIERS" ]] || die "WANDORA_POSTGRES_READBACK_VERIFIERS is required (id=sha256,id=sha256)"
[[ "$EXEC_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,79}$ ]] || die "invalid exec user"
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,79}$ ]] || die "invalid db user"
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,79}$ ]] || die "invalid db name"

test -f "$INSTALL_DIR/dist/docker/read-proxy.js" || die "missing $INSTALL_DIR/dist/docker/read-proxy.js"
test -S /var/run/docker.sock || die "Docker socket not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER not found"
docker exec -u "$EXEC_USER" "$CONTAINER" psql --version >/dev/null 2>&1 || die "psql unavailable for exec user $EXEC_USER in $CONTAINER"

for item in ${VERIFIERS//,/ }; do
  [[ "$item" =~ ^[a-z0-9][a-z0-9_.-]{1,79}=[a-f0-9]{64}$ ]] || die "invalid verifier mapping: $item"
done

cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=Wandora governed Docker read proxy with pinned PostgreSQL verifier
After=docker.service network.target
Requires=docker.service
Before=$AGENT_SERVICE

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
Environment=BIND_HOST=127.0.0.1
Environment=DOCKER_SOCKET_PATH=/var/run/docker.sock
Environment=ALLOWED_DOCKER_CONTAINERS=$CONTAINER
Environment=POSTGRES_READBACK_CONTAINER=$CONTAINER
Environment=POSTGRES_READBACK_VERIFIERS=$VERIFIERS
Environment=POSTGRES_READBACK_EXEC_USER=$EXEC_USER
Environment=POSTGRES_READBACK_DB_USER=$DB_USER
Environment=POSTGRES_READBACK_DB_NAME=$DB_NAME
ExecStart=/usr/bin/node $INSTALL_DIR/dist/docker/read-proxy.js
Restart=on-failure
RestartSec=2
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
MemoryMax=512M
CPUQuota=100%
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

install -d -m 0755 "$DROPIN_DIR"
cat >"$DROPIN_FILE" <<UNIT
[Service]
Environment=DOCKER_HOST=tcp://127.0.0.1:$PORT
UNIT

chmod 0644 "$SERVICE_FILE" "$DROPIN_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true; die "read proxy failed health check"; }

systemctl restart "$AGENT_SERVICE"
systemctl is-active --quiet "$AGENT_SERVICE" || die "$AGENT_SERVICE failed after DOCKER_HOST drop-in"

ok "Pinned PostgreSQL readback proxy is active"
printf 'service=%s\n' "$SERVICE_NAME"
printf 'container=%s\n' "$CONTAINER"
printf 'verifiers=%s\n' "$VERIFIERS"
printf 'agent_docker_host=tcp://127.0.0.1:%s\n' "$PORT"
