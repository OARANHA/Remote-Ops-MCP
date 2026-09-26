#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bash -n install-agent.sh

grep -q 'WANDORA_CONTROL_PLANE' install-agent.sh
grep -q 'https://mcp.wandora.com.br' install-agent.sh
grep -q 'node_22.x' install-agent.sh
grep -q 'ops-mcp' install-agent.sh
grep -q 'run_as_agent pair' install-agent.sh
grep -q 'heartbeat-once' install-agent.sh
grep -q 'NoNewPrivileges=yes' install-agent.sh
grep -q 'ProtectSystem=strict' install-agent.sh
grep -q 'ProtectHome=yes' install-agent.sh
grep -q 'CapabilityBoundingSet=' install-agent.sh
grep -q 'AmbientCapabilities=' install-agent.sh
grep -q 'ReadWritePaths=$STATE_DIR' install-agent.sh
grep -q 'Next: create/associate a Target Registry entry' install-agent.sh

grep -q 'One-time pairing code' src/agent/cli.ts
grep -q 'Agent Mesh Devices' src/agent/cli.ts
grep -q 'terminalLink' src/agent/cli.ts

if grep -Eq '(usermod|gpasswd|adduser)[^\n]*(docker|sudo)|NOPASSWD|chmod[[:space:]]+777' install-agent.sh; then
  echo 'installer contains a forbidden privilege escalation pattern' >&2
  exit 1
fi

if grep -Eq '/admin/pair/approve|approvePairingByCode' install-agent.sh; then
  echo 'installer must never auto-approve Agent Mesh pairing' >&2
  exit 1
fi

if grep -Eq 'docker[[:space:]]+(run|pull|exec)|systemctl[[:space:]]+(restart|stop)[[:space:]]+(docker|containerd)' install-agent.sh; then
  echo 'installer must not require Docker or mutate the Docker daemon' >&2
  exit 1
fi

echo 'AGENT_INSTALLER_V1=GREEN'
