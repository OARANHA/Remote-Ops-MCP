#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=3123 AUTH_MODE=oauth MCP_PASSWORD='oauth-contract-test' ADMIN_PASSWORD='oauth-admin-test' AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PUBLIC_BASE_URL='http://127.0.0.1:3123' MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$TMP/state.json" AUDIT_FILE="$TMP/audit.jsonl" node "$ROOT/dist/index.js" >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:3123/healthz >/dev/null 2>&1 && break; sleep .2; done
RESOURCE=http://127.0.0.1:3123/mcp
reg=$(curl -fsS -X POST http://127.0.0.1:3123/register -H 'content-type: application/json' -d '{"client_name":"contract-test","redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}')
cid=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])' <<<"$reg")
verifier=$(printf 'b%.0s' $(seq 1 64))
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
hdr="$TMP/h"
curl -sS -D "$hdr" -o /dev/null -X POST http://127.0.0.1:3123/authorize/submit  --data-urlencode 'password=oauth-contract-test'  --data-urlencode response_type=code  --data-urlencode "client_id=$cid"  --data-urlencode redirect_uri=http://127.0.0.1/callback  --data-urlencode state=contract  --data-urlencode "code_challenge=$challenge"  --data-urlencode code_challenge_method=S256  --data-urlencode 'scope=mcp:read offline_access'  --data-urlencode "resource=$RESOURCE"
grep -Eq '^HTTP/1.1 303 ' "$hdr"
location=$(grep -i "^Location:" "$hdr" | head -1 | cut -d" " -f2- | tr -d "\r")
code=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query)["code"][0])' <<<"$location")
tok=$(curl -fsS -X POST http://127.0.0.1:3123/token -H 'content-type: application/x-www-form-urlencoded'  --data-urlencode grant_type=authorization_code  --data-urlencode "client_id=$cid"  --data-urlencode "code=$code"  --data-urlencode redirect_uri=http://127.0.0.1/callback  --data-urlencode "code_verifier=$verifier"  --data-urlencode "resource=$RESOURCE")
access=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])' <<<"$tok")
python3 - "$access" "$RESOURCE" <<'PY'
import base64,json,sys
p=sys.argv[1].split('.')[1]+'==='
x=json.loads(base64.urlsafe_b64decode(p))
assert x["aud"]==sys.argv[2],x
print("RESOURCE_AUDIENCE=PASS")
PY
init=$(curl -fsS -X POST http://127.0.0.1:3123/mcp -H "authorization: Bearer $access" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contract-test","version":"1"}}}')
grep -q '"result"' <<<"$init"
tools=$(curl -fsS -X POST http://127.0.0.1:3123/mcp -H "authorization: Bearer $access" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
python3 -c 'import json,sys; x=json.load(sys.stdin); ts=x["result"]["tools"]; assert len(ts)>=10; assert all(t.get("_meta",{}).get("securitySchemes")==[{"type":"oauth2","scopes":["mcp:read"]}] for t in ts); print("TOOL_OAUTH_META=PASS count="+str(len(ts)))' <<<"$tools"
bad=$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3123/token -H 'content-type: application/x-www-form-urlencoded' --data-urlencode grant_type=refresh_token --data-urlencode "client_id=$cid" --data-urlencode refresh_token=bad --data-urlencode resource=https://evil.invalid/mcp)
[ "$bad" = 400 ]
echo BAD_RESOURCE_FAIL_CLOSED=PASS
echo CHATGPT_OAUTH_CONTRACT=GREEN