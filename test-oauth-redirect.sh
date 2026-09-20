#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=3122 AUTH_MODE=oauth MCP_PASSWORD='oauth-redirect-test' ADMIN_PASSWORD='oauth-admin-test' AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PUBLIC_BASE_URL='http://127.0.0.1:3122' MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$TMP/state.json" AUDIT_FILE="$TMP/audit.jsonl" node "$ROOT/dist/index.js" >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:3122/healthz >/dev/null 2>&1 && break; sleep .2; done
reg=$(curl -fsS -X POST http://127.0.0.1:3122/register -H 'content-type: application/json' -d '{"client_name":"redirect-test","redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}')
cid=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])' <<<"$reg")
verifier=$(printf 'a%.0s' $(seq 1 64))
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
hdr="$TMP/h"
curl -sS -D "$hdr" -o /dev/null -X POST http://127.0.0.1:3122/authorize/submit   --data-urlencode 'password=oauth-redirect-test'   --data-urlencode response_type=code   --data-urlencode "client_id=$cid"   --data-urlencode redirect_uri=http://127.0.0.1/callback   --data-urlencode state=test   --data-urlencode "code_challenge=$challenge"   --data-urlencode code_challenge_method=S256   --data-urlencode 'scope=mcp:read offline_access'
grep -Eq '^HTTP/1.1 303 ' "$hdr"
grep -Eiq '^Location: http://127.0.0.1/callback\?code=' "$hdr"
echo OAUTH_REDIRECT_303=GREEN