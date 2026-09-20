# Security model

## Goals

Remote Ops MCP lets an AI/MCP client inspect explicitly authorized Linux systems while keeping the remote-operation authority substantially narrower than direct SSH.

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

## Persistence

`STATE_FILE` stores:

- dynamic client metadata;
- SHA-256 authorization-code hashes;
- active session ids and SHA-256 refresh-token hashes;
- target runtime controls/last-seen data;
- aggregate monthly usage.

It does not store raw authorization codes, refresh tokens, OAuth passwords, `AUTH_SECRET` or SSH private keys.

The V1.1 store is single-writer. Atomic replacement protects against partial writes, but it is not a distributed database.

## Explicit non-goals in V1.1

- arbitrary command execution;
- service/container restart;
- package installation;
- file write/edit/delete;
- deployment execution;
- privilege escalation;
- automatic discovery of unregistered hosts.

Those capabilities, if ever required, need a separate capability authority with explicit per-action grants, idempotency and postcondition verification.
