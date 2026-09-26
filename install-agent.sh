#!/usr/bin/env bash
set -Eeuo pipefail

CONTROL_PLANE="${WANDORA_CONTROL_PLANE:-https://mcp.wandora.com.br}"
REPO_URL="${WANDORA_AGENT_REPO_URL:-https://github.com/OARANHA/Remote-Ops-MCP.git}"
REF="${WANDORA_AGENT_REF:-main}"
BASE_DIR="${WANDORA_AGENT_BASE_DIR:-/opt/wandora}"
INSTALL_DIR="${WANDORA_AGENT_DIR:-$BASE_DIR/remote-ops-agent}"
STATE_DIR="${WANDORA_AGENT_STATE_DIR:-/var/lib/wandora-ops-agent}"
STATE_FILE="${WANDORA_AGENT_STATE:-$STATE_DIR/device.json}"
SERVICE_NAME="wandora-ops-agent.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
AGENT_USER="ops-mcp"
AGENT_GROUP="ops-mcp"
ADMIN_URL=""
REPAIR=0
SKIP_NODE_INSTALL=0

usage() {
  cat <<'EOF'
Wandora Ops Agent installer

Usage:
  sudo bash install-agent.sh [options]

Options:
  --control-plane URL   Control plane (default: https://mcp.wandora.com.br)
  --ref REF             Git branch/tag to install (default: main)
  --re-pair             Revoke local pairing state and request a new WD code
  --skip-node-install   Do not install Node.js automatically
  -h, --help            Show help

Environment overrides:
  WANDORA_CONTROL_PLANE
  WANDORA_AGENT_REPO_URL
  WANDORA_AGENT_REF
  WANDORA_AGENT_BASE_DIR
  WANDORA_AGENT_DIR
  WANDORA_AGENT_STATE_DIR
  WANDORA_AGENT_STATE
EOF
}

log() { printf '\033[1;34m[wandora]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --control-plane)
      [[ $# -ge 2 ]] || die "--control-plane requires a value"
      CONTROL_PLANE="$2"; shift 2 ;;
    --ref)
      [[ $# -ge 2 ]] || die "--ref requires a value"
      REF="$2"; shift 2 ;;
    --re-pair)
      REPAIR=1; shift ;;
    --skip-node-install)
      SKIP_NODE_INSTALL=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown argument: $1" ;;
  esac
done

CONTROL_PLANE="${CONTROL_PLANE%/}"
ADMIN_URL="$CONTROL_PLANE/admin"

[[ "${EUID}" -eq 0 ]] || die "run with sudo/root"
[[ "$CONTROL_PLANE" =~ ^https?:// ]] || die "invalid control plane URL: $CONTROL_PLANE"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  ID="unknown"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  die "this installer currently supports Debian/Ubuntu hosts with apt-get"
fi

export DEBIAN_FRONTEND=noninteractive

install_base_packages() {
  log "Installing/verifying base packages..."
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl gnupg git >/dev/null
  ok "Base packages ready"
}

node_major() {
  local bin="$1"
  "$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

ensure_node22() {
  local major=""
  if [[ -x /usr/bin/node ]]; then
    major="$(node_major /usr/bin/node)"
  fi

  if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
    ok "Node.js $(/usr/bin/node --version) already available"
    return
  fi

  if (( SKIP_NODE_INSTALL )); then
    die "Node.js >=22 is required at /usr/bin/node"
  fi

  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "automatic Node.js installation is supported only on Debian/Ubuntu" ;;
  esac

  log "Installing Node.js 22..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key     | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n'     "$(dpkg --print-architecture)"     > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y --no-install-recommends nodejs >/dev/null

  major="$(node_major /usr/bin/node)"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 ))     || die "Node.js >=22 installation failed"

  ok "Node.js $(/usr/bin/node --version) installed"
}

ensure_agent_user() {
  if ! id "$AGENT_USER" >/dev/null 2>&1; then
    log "Creating restricted service user $AGENT_USER..."
    useradd       --system       --create-home       --home-dir "$STATE_DIR"       --shell /usr/sbin/nologin       "$AGENT_USER"
  fi

  if id -nG "$AGENT_USER" | grep -Eq '(^| )(sudo|docker)( |$)'; then
    die "$AGENT_USER must not belong to sudo/docker groups"
  fi

  install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$STATE_DIR"
  ok "Restricted service user ready"
}

install_agent_code() {
  local stage backup ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  stage="$BASE_DIR/.remote-ops-agent-stage-$$"
  backup="$BASE_DIR/remote-ops-agent.prev-$ts"

  install -d -m 0755 "$BASE_DIR"
  rm -rf -- "$stage"

  log "Fetching Remote-Ops-MCP ($REF)..."
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$stage"

  (
    cd "$stage"
    npm ci --no-audit --no-fund >/dev/null
    npm run build >/dev/null
    npm prune --omit=dev --no-audit --no-fund >/dev/null
  )

  test -f "$stage/dist/agent/cli.js" || die "agent build missing dist/agent/cli.js"
  test -f "$stage/dist/agent/operations.js" || die "agent build missing dist/agent/operations.js"

  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    mv "$INSTALL_DIR" "$backup"
    warn "Previous agent kept at $backup"
  fi

  mv "$stage" "$INSTALL_DIR"
  chown -R root:root "$INSTALL_DIR"
  chmod -R go-w "$INSTALL_DIR"

  ok "Agent installed at $INSTALL_DIR"
}

install_systemd_unit() {
  cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=Wandora Ops Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
Group=$AGENT_GROUP
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=WANDORA_CONTROL_PLANE=$CONTROL_PLANE
Environment=WANDORA_AGENT_STATE=$STATE_FILE
ExecStart=/usr/bin/node $INSTALL_DIR/dist/agent/cli.js run
Restart=always
RestartSec=5
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
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$STATE_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

  chmod 0644 "$SERVICE_FILE"
  systemctl daemon-reload
  ok "systemd unit installed"
}

print_admin_link() {
  printf '\nApprove this device in Agent Mesh Devices:\n'
  if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
    printf '  \033]8;;%s\a%s\033]8;;\a\n\n' "$ADMIN_URL" "$ADMIN_URL"
  else
    printf '  %s\n\n' "$ADMIN_URL"
  fi
}

try_open_local_browser() {
  # Remote SSH shells cannot open the browser on the administrator workstation.
  # If this installer is run from a local graphical terminal, open the Admin page.
  [[ -z "${SSH_CONNECTION:-}" ]] || return 0
  [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || return 0
  command -v xdg-open >/dev/null 2>&1 || return 0

  local desktop_user="${SUDO_USER:-}"
  if [[ -n "$desktop_user" && "$desktop_user" != "root" ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$desktop_user" -- xdg-open "$ADMIN_URL" >/dev/null 2>&1 &
  else
    xdg-open "$ADMIN_URL" >/dev/null 2>&1 &
  fi
}

run_as_agent() {
  runuser -u "$AGENT_USER" --     env       HOME="$STATE_DIR"       WANDORA_CONTROL_PLANE="$CONTROL_PLANE"       WANDORA_AGENT_STATE="$STATE_FILE"       /usr/bin/node "$INSTALL_DIR/dist/agent/cli.js" "$@"
}

pair_if_needed() {
  if (( REPAIR )) && [[ -f "$STATE_FILE" ]]; then
    local backup="$STATE_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    cp -a "$STATE_FILE" "$backup"
    rm -f "$STATE_FILE"
    warn "Previous device state backed up at $backup"
  fi

  if [[ -f "$STATE_FILE" ]]; then
    log "Existing pairing found; verifying device credential..."
    if run_as_agent heartbeat-once; then
      ok "Existing pairing is valid"
      return
    fi
    die "Existing pairing is invalid. Re-run with --re-pair after revoking/confirming the old device."
  fi

  printf '\n'
  printf '============================================================\n'
  printf '  WANDORA AGENT MESH — DEVICE PAIRING\n'
  printf '============================================================\n'
  print_admin_link
  try_open_local_browser

  # The CLI prints the one-time WD-XXXX-XXXX code and waits for Admin approval.
  run_as_agent pair

  [[ -s "$STATE_FILE" ]] || die "pairing completed without creating device state"
  ok "Pairing approved"

  run_as_agent heartbeat-once
  ok "Device credential validated"
}

start_agent() {
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"

  local i
  for i in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      break
    fi
    sleep 0.5
  done

  systemctl is-active --quiet "$SERVICE_NAME"     || { journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true; die "agent service failed to start"; }

  local device_id
  device_id="$(/usr/bin/node -e 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(s.device_id||""));' "$STATE_FILE")"
  [[ "$device_id" =~ ^dev_ ]] || die "paired device_id is missing"

  printf '\n'
  ok "wandora-ops-agent.service is active"
  printf '\nWANDORA_AGENT=READY\n'
  printf 'device_id=%s\n' "$device_id"
  printf 'admin=%s\n' "$ADMIN_URL"
  printf 'service=%s\n' "$SERVICE_NAME"
  printf 'state=%s\n' "$STATE_FILE"
  printf '\nNext: create/associate a Target Registry entry with deviceId=%s and transport=agent.\n' "$device_id"
}

main() {
  printf '\nWandora Ops Agent Installer\n\n'
  printf 'Control plane: %s\n' "$CONTROL_PLANE"
  printf 'Agent source:  %s @ %s\n\n' "$REPO_URL" "$REF"

  install_base_packages
  ensure_node22
  ensure_agent_user
  install_agent_code
  install_systemd_unit
  pair_if_needed
  start_agent
}

main "$@"
