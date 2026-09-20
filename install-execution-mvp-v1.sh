#!/usr/bin/env bash
set -euo pipefail

BASE=/opt/wandora/stacks/remote-ops-mcp
BUNDLE="$BASE/host-agent-bundle"
AGENT_DST=/opt/wandora/remote-ops-agent
BROKER_DST=/opt/wandora/remote-ops-exec-broker
WORKSPACE=/opt/wandora/ops-workspace
TARGETS="$BASE/runtime/config/targets.json"

if [ "${EUID}" -ne 0 ]; then echo "ERROR: execute com sudo." >&2; exit 1; fi
test -f "$BUNDLE/dist/agent/cli.js"
test -f "$BUNDLE/dist/agent/operations.js"
test -f "$BUNDLE/dist/agent/exec-broker-client.js"
test -f "$BUNDLE/dist/exec/broker.js"
test -f "$TARGETS"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
cp "$TARGETS" "$TARGETS.bak-execution-mvp-$TS"

id ops-mcp >/dev/null 2>&1 || { echo "ERROR: ops-mcp ausente"; exit 1; }
if id -nG ops-mcp | grep -Eq '(^| )(sudo|docker)( |$)'; then echo "ERROR: ops-mcp possui grupo privilegiado"; exit 1; fi
if ! id wandora-exec >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/wandora-exec --shell /usr/sbin/nologin wandora-exec
fi
if id -nG wandora-exec | grep -Eq '(^| )(sudo|docker|wandora-ops)( |$)'; then echo "ERROR: wandora-exec possui grupo privilegiado"; exit 1; fi

install -d -o wandora-exec -g ops-mcp -m 0770 "$WORKSPACE"
install -d -o root -g root -m 0755 "$BROKER_DST"
install -o root -g root -m 0755 "$BUNDLE/dist/exec/broker.js" "$BROKER_DST/broker.mjs"
install -o root -g root -m 0644 "$BUNDLE/dist/agent/cli.js" "$AGENT_DST/dist/agent/cli.js"
install -o root -g root -m 0644 "$BUNDLE/dist/agent/operations.js" "$AGENT_DST/dist/agent/operations.js"
install -o root -g root -m 0644 "$BUNDLE/dist/agent/exec-broker-client.js" "$AGENT_DST/dist/agent/exec-broker-client.js"

cat >/etc/systemd/system/wandora-ops-exec-broker.service <<'UNIT'
[Unit]
Description=Wandora isolated execution broker
After=network.target
Before=wandora-ops-agent.service

[Service]
Type=simple
User=wandora-exec
Group=ops-mcp
ExecStart=/usr/bin/node /opt/wandora/remote-ops-exec-broker/broker.mjs
Restart=on-failure
RestartSec=2
RuntimeDirectory=wandora-ops-exec
RuntimeDirectoryMode=0750
Environment=WANDORA_EXEC_BROKER_SOCKET=/run/wandora-ops-exec/exec.sock
Environment=WANDORA_EXEC_ROOTS=/opt/wandora/ops-workspace
Environment=WANDORA_EXEC_PROGRAMS=bash,sh,git,node,npm,npx,pnpm,python3,curl,wget,jq,grep,sed,awk,find,head,tail,cat,wc,make
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
TasksMax=128
MemoryMax=1G
CPUQuota=200%
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/opt/wandora/ops-workspace /run/wandora-ops-exec
InaccessiblePaths=/var/lib/wandora-ops-agent /opt/wandora/stacks /root /home /etc/ssh /etc/ssl/private /var/run/docker.sock
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/wandora-ops-exec-broker.service

python3 - "$TARGETS" <<'PY'
import json,sys
p=sys.argv[1]; x=json.load(open(p))
found=False
for t in x["targets"]:
    if t.get("id")=="wandora-agent":
        found=True
        t["capabilityProfile"]="operator"
        t["allowedPaths"]=list(dict.fromkeys(t.get("allowedPaths",[])+["/opt/wandora/ops-workspace"]))
        t["allowedWritePaths"]=["/opt/wandora/ops-workspace"]
        t["allowedProcessCwds"]=["/opt/wandora/ops-workspace"]
        t["allowedProcessPrograms"]=["bash","sh","git","node","npm","npx","pnpm","python3","curl","wget","jq","grep","sed","awk","find","head","tail","cat","wc","make"]
if not found: raise SystemExit("wandora-agent target ausente")
open(p,"w").write(json.dumps(x,indent=2)+"\n")
PY
chown wandora-admin:wandora-ops "$TARGETS"
chmod 0640 "$TARGETS"

systemctl daemon-reload
systemctl enable --now wandora-ops-exec-broker.service
systemctl restart wandora-ops-agent.service
docker restart remote-ops-mcp >/dev/null

for _ in $(seq 1 40); do
  [ -S /run/wandora-ops-exec/exec.sock ] && systemctl is-active --quiet wandora-ops-agent.service && curl -fsS http://127.0.0.1:3005/readyz >/dev/null 2>&1 && break
  sleep .25
done

test -S /run/wandora-ops-exec/exec.sock
systemctl is-active --quiet wandora-ops-exec-broker.service
systemctl is-active --quiet wandora-ops-agent.service
curl -fsS http://127.0.0.1:3005/readyz >/dev/null
if id -nG ops-mcp | grep -Eq '(^| )(sudo|docker)( |$)'; then echo "ERROR: privileged ops-mcp"; exit 1; fi
if id -nG wandora-exec | grep -Eq '(^| )(sudo|docker|wandora-ops)( |$)'; then echo "ERROR: privileged wandora-exec"; exit 1; fi

echo EXECUTION_MVP_INSTALL=GREEN
echo broker=wandora-ops-exec-broker.service
echo agent=wandora-ops-agent.service
echo workspace="$WORKSPACE"
echo privileged_groups=none
echo target=wandora-agent
