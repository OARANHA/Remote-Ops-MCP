# Operations

## Production topology

Run one active Remote Ops MCP container behind the existing HTTPS reverse proxy. Keep the application port bound to loopback. Persist only `/app/data`; mount target configuration and SSH key material read-only.

Recommended host layout:

```text
/opt/remote-ops-mcp/
  config/targets.json
  data/state.json
  data/audit.jsonl
  secrets/<ssh keys>
  .env              # root/operator readable only
```

## Deploy / upgrade

Preferred flow:

1. CI builds and tests the exact commit.
2. The container workflow publishes `ghcr.io/.../remote-ops-mcp` with a SHA tag.
3. Pin the Portainer stack to the intended SHA tag for production.
4. Pull/redeploy the stack.
5. Verify `/healthz`, `/admin`, OAuth metadata, target listing and a safe read-only probe.
6. Keep the previous SHA available for rollback.

Do not build arbitrary unreviewed working-tree contents directly on the production VPS.

## Revoke operations

The admin console supports:

- **target revoke** — closes the target SSH pool and blocks future MCP calls to it;
- **session revoke** — immediately invalidates one connector session;
- **client revoke** — invalidates the client and every active session belonging to it;
- **revoke all** — emergency kill switch for every MCP client session.

A target disabled in the static registry stays disabled even if the runtime control says enabled.

## Persistence and backup

Back up `data/state.json` and `data/audit.jsonl` together with the static `targets.json`. Do **not** put them in Git. Preserve file permissions. A state-file loss is fail-closed for existing sessions; clients must authorize again.

The JSON state implementation assumes a **single active writer/container**. Do not run active/active replicas against the same file.

## Audit and retention

Each tool call writes a bounded event to stdout and `AUDIT_FILE`. Sensitive tool output is never copied into audit metadata. Configure host/container log retention and rotate the JSONL audit file according to operational policy.

## Secret rotation

- Rotating `MCP_PASSWORD` changes future authorization but does not by itself invalidate already active sessions; use Revoke All when that is desired.
- Rotating `AUTH_SECRET` invalidates all access tokens and admin cookies immediately. Use it as a stronger emergency credential reset.
- Rotating an SSH key/fingerprint must be performed as a target-onboarding change and revalidated before enabling the target.

## Failure recovery

If the admin UI is unavailable but the container is healthy, do not weaken OAuth. Inspect the container health/logs locally on the host. If state is suspected corrupt, stop the app before restoring the state file; never edit it while the process is writing.

If a target unexpectedly changes SSH host key, the correct response is fail-closed. Verify the target out of band before changing the pinned fingerprint.
