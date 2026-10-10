# OpenHands ↔ Remote Ops MCP — Agent Mesh Bridge V1

**Status:** PR-only; no production rollout, new credential, target permission or agent deployment authorized.
**Scope:** one OpenHands instance on VPS Vigia, served privately at `http://127.0.0.1:18080` (from the Vigia Agent Mesh process).

## Why this integration

Reuse the existing OAuth-protected Remote Ops MCP, Agent Mesh transport, Target Registry capabilities, redacted audit and signed admin gates. Do not create another public MCP endpoint or grant Docker socket / unrestricted shell access.

Current OpenHands Agent Server was inspected in the running VPS: version **1.53.0**. The real API supports `GET /health`, `GET /api/conversations/search`, `GET /api/conversations/{id}`, `GET /api/conversations/{id}/agent_final_response`, `POST /api/conversations` and `POST /api/conversations/{id}/goal/stop`. The last five require `X-Session-API-Key`. Note: `GET /api/conversations` requires explicit IDs, so it is **not** used for list-all.

## Security contract

- The bridge only talks to **fixed loopback** `127.0.0.1:18080`; callers cannot choose a URL, port, file, workspace or path.
- The backend API credential is loaded on **the Vigia host** from the fixed path `/etc/wandora/openhands/session_api_key`, never accepted as a tool argument, returned to ChatGPT, checked into Git or included in structured errors. The file **does not exist as part of this PR**. Provision only after separate approval and validation of API-key rotation and service-user permissions.
- Keep its filesystem permissions strict (for example `0600` owned by the service account that executes the Agent Mesh operation); deny the isolated execution-broker user any access to the key.
- Agent Mesh enforces its own authenticated device identity; the MCP Target Registry must **explicitly opt in** to `allowedSemanticCapabilities`:
  - `openhands.read`: `openhands_health`, `openhands_list`, `openhands_status`, `openhands_result`.
  - `openhands.execute`: `openhands_start`, `openhands_stop`. Additionally, execute requires `capabilityProfile=operator`. A read-only target **cannot** start or stop work.
- The start tool pins the workspace to `/projects/mcp-coordination-lab`, caps iterations at 20 and sets `confirmation_policy: {kind: AlwaysConfirm}`. The tool has no GitHub merge, deploy or general bash endpoint. This is *not* a substitute for strict GitHub branch protection and repository identity isolation; OpenHands agents may have their own built-in tools.
- Stop requires an exact UUID confirmation. List and status return only allowlisted fields. Final agent text is truncated to 4,000 chars and remains potentially sensitive; treat as untrusted data and protect with MCP authorization.
- Requests are bounded (timeout ≤20s, response JSON ≤128 KiB), reject redirects and do not expose upstream authentication error bodies.
- Existing audit records MCP tool name, actor, target, outcome and timing, with no raw API credentials. Avoid operational logs of raw OpenHands HTTP bodies.

## Rollout prerequisites (NOT performed by this PR)

1. Review and approve this PR and let CI report. No polling of CI required.
2. Verify the existing Canvas Cloudflare Access and origin restrictions remain correct; ensure direct IP origin bypass is blocked and improve origin trust beyond a Cloudflare IP allowlist.
3. Validate that a machine/service API key with revocation or rotation support can be safely provisioned for the Agent Server; do **not** reuse the GitHub token or the Chutes token. Provision it locally, with no copy into MCP control plane.
4. Ensure only the intended Vigia Agent Mesh service user can read the fixed key file. Ensure no generic operator process broker can read it.
5. Deploy the reviewed **control-plane MCP update and Agent Mesh runtime update** separately: both sides are required because `openhands.*` is a new host-local operation. Each deployment needs explicit owner approval. Do not touch ELUS, VIGIAFAST, GitHub or other domains.
6. Opt in a dedicated **read-only** target to `openhands.read` and verify health/list/status. After a separate capability approval, optionally create an operator target with `openhands.execute`.
7. Configure dedicated GitHub automation identity with minimal repository permissions. Protect `main` via branch rules and required human review, with no merge bypass. Until proven, do not attach write credentials to the OpenHands runtime.
8. Prove one synthetic read-only task then an authorized low-cost sandbox run, including manual confirmation and end-to-end event/result/status. Reconnect ChatGPT MCP after deploying so new tool schemas appear.

## Local and CI tests

```bash
npm ci
npm run build
node --experimental-strip-types --test test-openhands-bridge.mjs
```

Tests mock the OpenHands API: health, auth, list redaction, fixed workspace, AlwaysConfirm, UUID bounds, stop, upstream auth error redaction and oversize denial. The local tests do not consume LLM tokens or create real conversations.

## Open items / limitations

- The Cloudflare IP allowlist is defense in depth, not origin-side identity verification.
- The current Canvas relay systemd unit was last observed active but disabled on reboot. Persist it only via a separate approved action.
- The DNS-01 resolver was configured but renewal has not been proven over a full renewal lifecycle.
- No live authenticated list/start/stop test, GitHub token install, agent process deployment, CI result or merge is claimed by this PR.
