# Security model

## Goals

Remote Ops MCP lets an AI/MCP client inspect and operate explicitly authorized Linux systems while keeping each authority class explicit, revocable and auditable rather than silently inheriting direct SSH/root access.

The design assumes the MCP client and language model can make mistakes and that prompt content may be hostile. Therefore remote authority is constrained on the server side, not by instructions in a prompt.

## Trust boundaries

### Public HTTPS boundary

The public endpoint accepts MCP and OAuth traffic. Production uses OAuth 2.1 authorization code + PKCE S256. Dynamic clients are persisted, authorization codes are one-time and hashed, and refresh tokens are rotated and hashed at rest.

An access JWT is not sufficient on its own: it carries `cid` and `sid`, and the persisted client/session must still be active on every request. This makes revocation immediate.

### Admin boundary

`/admin` uses a separate password from MCP authorization. The browser receives a signed, HttpOnly, SameSite=Strict session cookie. State-changing actions require a CSRF token. The console intentionally omits SSH host addresses, usernames, key paths and secrets.

For an Internet-exposed deployment, an additional identity-aware proxy such as Cloudflare Access is recommended in front of the admin path.

### Target boundary

The client names only a logical target id. The server-side registry owns SSH host/user/key/fingerprint and per-target allowlists. Runtime controls may remove authority but cannot expand the registry.

SSH verifies the configured host-key fingerprint. Unknown targets and mismatches fail closed.

## Capability restrictions

There is no arbitrary-shell MCP tool. Remote commands are fixed templates. User arguments are schema-validated and shell-quoted where interpolation is necessary.

Filesystem tools enforce path allowlists and explicit secret-path denial. Docker/service/repository tools accept only resources listed for the target.

The SSH account must not be added to the host `docker` group as a convenience shortcut: Docker socket access is effectively root-equivalent. Production targets keep Docker access disabled unless a separate read-only broker/proxy is introduced and reviewed.

Output is bounded by byte/line limits and passes through secret redaction. `docker inspect` environment values are removed rather than returned and then redacted.

### Signed managed-admin boundary

Managed-admin is an explicit opt-in for routine root administration. It does **not** add the unprivileged `ops-mcp` identity to `sudo` or the Docker group.

The control plane derives an Ed25519 signing key from the existing `AUTH_SECRET` using a domain-separated seed. Only the public verification key is installed on the VPS. A privileged action follows this chain:

1. the MCP client calls `host_admin_prepare`; no host mutation occurs;
2. the user confirms the exact `APPROVE adm_...` token;
3. `host_admin_apply` rechecks target state, actor, live device and `host.managed_admin`;
4. the control plane signs an exact, short-lived ticket containing target, device, program, argv, cwd, timeout and a random nonce;
5. the Agent Mesh transports the opaque ticket;
6. the root broker verifies signature, device id, expiry, persistent nonce replay state and its own local allowlists before `spawn(..., shell=false)`.

The target registry and the host broker therefore form a double authority boundary. A compromised unprivileged agent can forward a valid ticket but cannot mint a new one. Managed-admin deliberately excludes shell/interpreter programs and is not a break-glass root shell.

## Persistence

`STATE_FILE` stores:

- dynamic client metadata;
- SHA-256 authorization-code hashes;
- active session ids and SHA-256 refresh-token hashes;
- target runtime controls/last-seen data;
- aggregate monthly usage.

It does not store raw authorization codes, refresh tokens, OAuth passwords, `AUTH_SECRET` or SSH private keys.

The V1.1 store is single-writer. Atomic replacement protects against partial writes, but it is not a distributed database.

## Current explicit non-goals

- unrestricted or implicit root shell access;
- silent privilege escalation from ordinary Agent Mesh pairing;
- bypassing prepare/apply approval for managed-admin actions;
- exposing raw host secrets as a convenience mechanism;
- automatic discovery or administration of unregistered hosts;
- treating managed-admin as authority to mutate unrelated product/domain boundaries.

Historical V1.1 intentionally excluded all mutation. Current operator and managed-admin capabilities were added as separate, explicit authorities with server-side allowlists, audit and human approval where privilege requires it.
