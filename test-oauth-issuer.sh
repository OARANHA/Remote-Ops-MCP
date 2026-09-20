#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=3124 AUTH_MODE=oauth MCP_PASSWORD='issuer-test' ADMIN_PASSWORD='issuer-admin' AUTH_SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PUBLIC_BASE_URL='http://127.0.0.1:3124' MOCK_MODE=1 TARGETS_FILE="$ROOT/config/targets.example.json" STATE_FILE="$TMP/state.json" AUDIT_FILE="$TMP/audit.jsonl" node "$ROOT/dist/index.js" >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:3124/healthz >/dev/null 2>&1 && break; sleep .2; done
meta=$(curl -fsS http://127.0.0.1:3124/.well-known/oauth-authorization-server)
python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["authorization_response_iss_parameter_supported"] is True; assert x["issuer"]=="http://127.0.0.1:3124"; print("ISS_METADATA=PASS")' <<<"$meta"
oidc=$(curl -fsS http://127.0.0.1:3124/.well-known/openid-configuration)
python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["authorization_response_iss_parameter_supported"] is True; print("OIDC_DISCOVERY=PASS")' <<<"$oidc"
reg=$(curl -fsS -X POST http://127.0.0.1:3124/register -H 'content-type: application/json' -d '{"client_name":"issuer-test","redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}')
cid=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])' <<<"$reg")
verifier=$(printf 'c%.0s' $(seq 1 64))
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
hdr="$TMP/h"
curl -sS -D "$hdr" -o /dev/null -X POST http://127.0.0.1:3124/authorize/submit  --data-urlencode 'password=issuer-test'  --data-urlencode response_type=code  --data-urlencode "client_id=$cid"  --data-urlencode redirect_uri=http://127.0.0.1/callback  --data-urlencode state=abc  --data-urlencode "code_challenge=$challenge"  --data-urlencode code_challenge_method=S256  --data-urlencode 'scope=mcp:read offline_access'  --data-urlencode 'resource=http://127.0.0.1:3124/mcp'
loc=$(grep -i '^Location:' "$hdr" | head -1 | cut -d' ' -f2- | tr -d '
')
python3 -c 'import sys,urllib.parse; q=urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query); assert q["iss"]==["http://127.0.0.1:3124"]; assert q["state"]==["abc"]; assert "code" in q; print("ISS_CALLBACK=PASS")' <<<"$loc"
echo OAUTH_ISSUER_BINDING=GREEN