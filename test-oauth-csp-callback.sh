#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=3126 AUTH_MODE=oauth MCP_PASSWORD='csp-test-pass' ADMIN_PASSWORD='csp-admin-pass' AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PUBLIC_BASE_URL='http://127.0.0.1:3126' MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$TMP/state.json" AUDIT_FILE="$TMP/audit.jsonl" node "$ROOT/dist/index.js" >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:3126/healthz >/dev/null 2>&1 && break; sleep .2; done
reg=$(curl -fsS -X POST http://127.0.0.1:3126/register -H 'content-type: application/json' -d '{"client_name":"csp-test","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"none"}')
cid=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])' <<<"$reg")
v=$(printf 'e%.0s' $(seq 1 64)); ch=$(printf %s "$v"|openssl dgst -sha256 -binary|openssl base64 -A|tr '+/' '-_'|tr -d '=')
page=$(curl -fsS "http://127.0.0.1:3126/authorize?response_type=code&client_id=$cid&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&scope=offline_access%20mcp%3Aread&code_challenge=$ch&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A3126%2Fmcp&state=s")
grep -q "form-action 'self' https://chatgpt.com" <<<"$page"
echo CSP_CALLBACK_ALLOWLIST=PASS
hdr="$TMP/h"
curl -sS -D "$hdr" -o /dev/null -X POST http://127.0.0.1:3126/authorize/submit  --data-urlencode password=csp-test-pass  --data-urlencode response_type=code  --data-urlencode "client_id=$cid"  --data-urlencode redirect_uri=https://chatgpt.com/connector_platform_oauth_redirect  --data-urlencode state=s  --data-urlencode "code_challenge=$ch"  --data-urlencode code_challenge_method=S256  --data-urlencode 'scope=offline_access mcp:read'  --data-urlencode resource=http://127.0.0.1:3126/mcp
grep -Eq '^HTTP/1.1 303 ' "$hdr"
grep -Eqi '^Location: https://chatgpt.com/connector_platform_oauth_redirect\?code=' "$hdr"
echo CROSS_ORIGIN_CALLBACK_REDIRECT=PASS
echo OAUTH_CSP_CALLBACK=GREEN