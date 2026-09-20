#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=3118 AUTH_MODE=oauth MCP_PASSWORD='pair-test-mcp-123' ADMIN_PASSWORD='pair-test-admin-456' AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PUBLIC_BASE_URL='http://127.0.0.1:3118' MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$TMP/state.json" AUDIT_FILE="$TMP/audit.jsonl" node dist/index.js >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:3118/healthz >/dev/null 2>&1 && break; sleep .2; done
start=$(curl -fsS -X POST http://127.0.0.1:3118/agent/pair/start -H 'Content-Type: application/json' -d '{"hostname":"pair-test-host","os":"Ubuntu","agent_version":"2.0.0-test","fingerprint":"sha256:testfingerprint0001"}')
code=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["pairing_code"])' <<<"$start")
pairing_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["pairing_id"])' <<<"$start")
poll_token=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["poll_token"])' <<<"$start")
[[ "$code" =~ ^WD-[A-Z2-9]{4}-[A-Z2-9]{4}$ ]]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3118/agent/pair/claim -H 'Content-Type: application/json' -d "{\"pairing_id\":\"$pairing_id\",\"poll_token\":\"$poll_token\"}")" = 202 ]
jar="$TMP/cookie"
curl -fsS -c "$jar" -X POST http://127.0.0.1:3118/admin/login --data-urlencode 'password=pair-test-admin-456' -o /dev/null
page=$(curl -fsS -b "$jar" http://127.0.0.1:3118/admin/)
csrf=$(grep -o 'name="csrf" value="[^"]*"' <<<"$page" | head -1 | sed -E 's/.*value="([^"]*)".*/\1/')
curl -fsS -b "$jar" -X POST http://127.0.0.1:3118/admin/pair/approve --data-urlencode "csrf=$csrf" --data-urlencode "code=$code" -o /dev/null
claim=$(curl -fsS -X POST http://127.0.0.1:3118/agent/pair/claim -H 'Content-Type: application/json' -d "{\"pairing_id\":\"$pairing_id\",\"poll_token\":\"$poll_token\"}")
device_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["device_id"])' <<<"$claim")
device_token=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["device_token"])' <<<"$claim")
curl -fsS -X POST http://127.0.0.1:3118/agent/heartbeat -H "Authorization: Bearer $device_token" -H 'Content-Type: application/json' -d '{"agent_version":"2.0.0-test","capabilities":["host.status"]}' | grep -q '"status":"ok"'
page=$(curl -fsS -b "$jar" http://127.0.0.1:3118/admin/)
csrf=$(grep -o 'name="csrf" value="[^"]*"' <<<"$page" | head -1 | sed -E 's/.*value="([^"]*)".*/\1/')
curl -fsS -b "$jar" -X POST "http://127.0.0.1:3118/admin/agent-devices/$device_id/revoke" --data-urlencode "csrf=$csrf" -o /dev/null
[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3118/agent/heartbeat -H "Authorization: Bearer $device_token" -H 'Content-Type: application/json' -d '{}')" = 401 ]
echo 'AGENT_PAIRING_V1=GREEN'