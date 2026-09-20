#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
PASS=0
ok(){ PASS=$((PASS+1)); printf 'PASS %02d: %s\n' "$PASS" "$1"; }
contains(){ grep -Fq "$2" <<<"$1" || { echo "FAIL: expected [$2] in response"; echo "$1" | head -c 1000; exit 1; }; ok "$3"; }
not_contains(){ ! grep -Fq "$2" <<<"$1" || { echo "FAIL: forbidden [$2] leaked"; exit 1; }; ok "$3"; }
wait_health(){ for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0; sleep .25; done; cat "$2"; return 1; }
start_server(){ local port="$1" mode="$2" state="$3" audit="$4" log="$5"; shift 5; env PORT="$port" AUTH_MODE="$mode" MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$state" AUDIT_FILE="$audit" "$@" node dist/index.js >"$log" 2>&1 & PIDS+=("$!"); wait_health "$port" "$log"; }
stop_last(){ local i=$((${#PIDS[@]}-1)); local p="${PIDS[$i]}"; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; unset 'PIDS[$i]'; PIDS=("${PIDS[@]}"); }
mcp(){ local port="$1" body="$2" token="${3:-}"; local auth=(); [ -n "$token" ] && auth=(-H "Authorization: Bearer $token"); curl -fsS -X POST "http://127.0.0.1:$port/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "${auth[@]}" -d "$body"; }

echo '== noauth + mock =='
start_server 3111 noauth "$TMP/state-noauth.json" "$TMP/audit-noauth.jsonl" "$TMP/noauth.log"
r="$(curl -fsS http://127.0.0.1:3111/healthz)"; contains "$r" '"status":"ok"' 'health probe'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')"; contains "$r" '"serverInfo"' 'MCP initialize'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"; n="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))' <<<"$r")"; [ "$n" = 19 ] || { echo "FAIL: expected 19 tools, got $n"; exit 1; }; ok '19 read-only tools exposed'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"host_status","arguments":{"target":"demo-mock"}}}')"; contains "$r" 'wandora-prod-mock' 'mock target execution'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_file","arguments":{"target":"demo-mock","path":"/opt/wandora/.env"}}}')"; contains "$r" 'SECRET_PATH_DENIED' 'secret path denied'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"service_status","arguments":{"target":"demo-mock","service":"app;cat /etc/shadow"}}}')"; contains "$r" 'INVALID_ARGUMENT' 'command injection denied'
r="$(mcp 3111 '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"docker_logs","arguments":{"target":"demo-mock","container":"wandora-web","lines":20}}}')"; contains "$r" '[REDACTED]' 'secret redaction active'; not_contains "$r" 'sk-abcdef1234567890' 'raw API key not leaked'
stop_last

echo '== OAuth + persistence + immediate revoke =='
MCP_PASS='e2e-mcp-password-12345'; ADMIN_PASS='e2e-admin-password-67890'; AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
OAUTH_ENV=(MCP_PASSWORD="$MCP_PASS" ADMIN_PASSWORD="$ADMIN_PASS" AUTH_SECRET="$AUTH_SECRET" PUBLIC_BASE_URL='http://127.0.0.1:3112')
start_server 3112 oauth "$TMP/state-oauth.json" "$TMP/audit-oauth.jsonl" "$TMP/oauth.log" "${OAUTH_ENV[@]}"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3112/mcp -H 'Content-Type: application/json' -d '{}')"; [ "$code" = 401 ] || { echo "FAIL: unauthenticated MCP returned $code"; exit 1; }; ok 'MCP requires bearer token'
r="$(curl -fsS http://127.0.0.1:3112/.well-known/oauth-authorization-server)"; contains "$r" '"registration_endpoint"' 'OAuth discovery advertises DCR'
r="$(curl -fsS -X POST http://127.0.0.1:3112/register -H 'Content-Type: application/json' -d '{"client_name":"ChatGPT E2E","redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}')"; cid="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["client_id"])' <<<"$r")"; [ -n "$cid" ] || exit 1; ok 'dynamic client registration'
verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc'; challenge="$(printf %s "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
redir="$(curl -sS -o /dev/null -w '%{redirect_url}' -X POST http://127.0.0.1:3112/authorize/submit --data-urlencode "password=$MCP_PASS" --data-urlencode 'response_type=code' --data-urlencode "client_id=$cid" --data-urlencode 'redirect_uri=http://127.0.0.1/callback' --data-urlencode 'state=e2e-state' --data-urlencode "code_challenge=$challenge" --data-urlencode 'code_challenge_method=S256' --data-urlencode 'scope=mcp:read offline_access')"
authcode="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query)["code"][0])' <<<"$redir")"; [ -n "$authcode" ] || exit 1; ok 'PKCE authorization code issued'
r="$(curl -fsS -X POST http://127.0.0.1:3112/token -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode 'grant_type=authorization_code' --data-urlencode "code=$authcode" --data-urlencode "code_verifier=$verifier" --data-urlencode "client_id=$cid" --data-urlencode 'redirect_uri=http://127.0.0.1/callback')"; token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"$r")"; refresh="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])' <<<"$r")"; [ -n "$token" ] && [ -n "$refresh" ] || exit 1; ok 'access + refresh token issued'
r="$(mcp 3112 '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}' "$token")"; contains "$r" '"tools"' 'authorized MCP call'
stop_last
start_server 3112 oauth "$TMP/state-oauth.json" "$TMP/audit-oauth.jsonl" "$TMP/oauth-restart.log" "${OAUTH_ENV[@]}"
r="$(mcp 3112 '{"jsonrpc":"2.0","id":8,"method":"tools/list","params":{}}' "$token")"; contains "$r" '"tools"' 'session survives server restart'
jar="$TMP/admin.cookie"; curl -fsS -c "$jar" -X POST http://127.0.0.1:3112/admin/login --data-urlencode "password=$ADMIN_PASS" -o /dev/null
page="$(curl -fsS -b "$jar" http://127.0.0.1:3112/admin/)"; csrf="$(python3 -c 'import re,sys; m=re.search(r"name=\"csrf\" value=\"([^\"]+)\"",sys.stdin.read()); print(m.group(1) if m else "")' <<<"$page")"; [ -n "$csrf" ] || { echo 'FAIL: admin CSRF not found'; exit 1; }; ok 'admin login + CSRF'
curl -fsS -b "$jar" -X POST http://127.0.0.1:3112/admin/revoke-all --data-urlencode "csrf=$csrf" -o /dev/null
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3112/mcp -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}')"; [ "$code" = 401 ] || { echo "FAIL: revoked token returned $code"; exit 1; }; ok 'admin revoke invalidates access token immediately'

printf '\nALL GREEN — %d checks passed\n' "$PASS"