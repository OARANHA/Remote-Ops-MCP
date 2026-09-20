# Remote Ops MCP

Remote Ops MCP is a **remote, read-only Model Context Protocol gateway** for operating Linux servers from MCP clients such as ChatGPT, without exposing SSH credentials, arbitrary shell access, or raw infrastructure details to the client.

The service is designed to run as a small control plane in Docker/Portainer. A client addresses logical targets such as `wandora-prod`; the gateway resolves the SSH host, key and capability allowlists on the server side.

## V1.1 control plane

V1.1 adds the operational layer needed for day-to-day use:

- **OAuth 2.1 + PKCE S256 + Dynamic Client Registration**.
- `offline_access` and rotating refresh tokens for long-lived MCP connections.
- **Durable authorization state** across container restarts.
- Access tokens bound to a persisted session (`sid`) and client (`cid`) so **revoke takes effect immediately**, not only after JWT expiry.
- **Admin console** with Devices, Clients, Usage, Audit and Settings views.
- Per-device enable/revoke control, per-client and per-session revoke, plus **Revoke all**.
- Runtime target revocation is an overlay that can only reduce authority granted by the static registry.
- JSONL audit log and monthly usage counters.
- SSH host-key pinning, allowlisted paths/containers/services/repos, output limits and secret redaction.
- No arbitrary command execution tool.
- `MOCK_MODE=1` for end-to-end validation without touching a real VPS.

## Architecture

```text
MCP client (ChatGPT / Claude / Cursor / custom agent)
        |
        | HTTPS + OAuth 2.1 / PKCE
        v
Remote Ops MCP
  |-- /mcp                 MCP endpoint
  |-- /admin               private operations console
  |-- durable state        clients/sessions/revocation/usage
  |-- target registry      logical id -> SSH/capability profile
  |-- audit JSONL          append-only operational evidence
  |
  `-- SSH read-only profile + pinned host key
        |
        +-- wandora-prod
        +-- medicspro-prod
        `-- other explicitly onboarded VPSs
```

## Read-only tools

The server currently exposes 19 tools.

| Group | Tools |
|---|---|
| Control | `health`, `targets_list`, `target_status` |
| Host | `host_status`, `disk_usage`, `memory_status`, `uptime` |
| Docker | `docker_list`, `docker_health`, `docker_inspect_safe`, `docker_logs` |
| systemd | `service_status`, `service_logs` |
| Git | `git_head`, `git_status`, `git_diff_summary` |
| Filesystem | `list_directory`, `read_file` |
| Summary | `runtime_summary` |

The model never supplies an arbitrary shell command. Every remote command is generated from a fixed template and validated arguments.

## Admin console

With `AUTH_MODE=oauth`, open `/admin` on the same HTTPS origin. The console deliberately shows only logical target metadata; it does not render SSH hosts, usernames, key paths or secrets.

From the console you can:

- see target online/last-seen state;
- run a safe connectivity probe;
- revoke or re-enable a target at runtime;
- inspect authorized MCP clients and sessions;
- revoke one session, one client, or all clients;
- inspect current-month tool usage;
- inspect a bounded tail of the redacted audit log.

`ADMIN_PASSWORD` is independent from the end-user OAuth `MCP_PASSWORD`. Admin mutations use a signed HttpOnly/SameSite cookie and CSRF token.

## Production deployment with Portainer

The preferred production path is:

```text
commit -> GitHub Actions CI -> GHCR image -> Portainer stack -> reverse proxy/TLS
```

`docker-compose.yml` binds a diagnostics port to loopback (`127.0.0.1:3005`) and also joins the external `wandora-edge` network so the existing Traefik instance can reverse-proxy the container directly on port 3000. The container is non-root, drops Linux capabilities, uses `no-new-privileges`, has a read-only root filesystem and mounts only the required config/data/secrets paths.

For an emergency/local build, apply `docker-compose.build.yml` as an override.

### Required production secrets

```bash
MCP_PASSWORD=<oauth authorization password>
ADMIN_PASSWORD=<separate admin-console password>
AUTH_SECRET=<at least 32 random characters; openssl rand -hex 32 is suitable>
```

Do not commit these values. Keep them in the Portainer stack environment or a root-owned environment/secrets file on the host.

## Configuration

Copy `config/targets.example.json` to the deployment host as `config/targets.json` and add only known targets. Each target declares its own path/container/service/repository allowlists and pinned SSH host fingerprint.

Important environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `AUTH_MODE` | `oauth` for production, `noauth` only for isolated tests | `oauth` |
| `PUBLIC_BASE_URL` | public HTTPS origin used in OAuth metadata | `https://mcp.wandora.com.br` |
| `STATE_FILE` | durable client/session/control state | `data/state.json` |
| `AUDIT_FILE` | JSONL audit log | `data/audit.jsonl` |
| `MOCK_MODE` | `1` disables real SSH and returns deterministic mocks | `0` |
| `RATE_LIMIT_PER_MIN` | MCP requests per IP/minute | `120` |
| `PER_TARGET_CONCURRENCY` | concurrent remote commands per target | `4` |

See `.env.example` for the complete set.

## Development and validation

```bash
npm install
npm run build
bash test-e2e.sh
```

The E2E suite validates both `noauth + MOCK_MODE` and the complete OAuth flow, including state persistence across a restart, refresh-token rotation, immediate session revocation, target revocation, admin CSRF protection, redaction, path restrictions and command-injection rejection.

## Security boundary

Remote Ops MCP is intentionally **not** a general remote shell. Its first production capability set is observation/read-only. Write operations, deploys, restarts and arbitrary scripts are outside V1.1 and must not be added by widening an existing tool. They require a separate capability contract, explicit allowlist, idempotency and postcondition verification.

The durable state file contains client metadata and **hashes** of refresh tokens/authorization codes, not their raw values. Access tokens are signed and additionally checked against current persisted session state on every MCP request.

## Documentation

- `docs/ADR-0001-CONTROL-PLANE.md` — V1.1 architectural decision.
- `docs/CHATGPT_CONNECTION.md` — connector setup and OAuth flow.
- `docs/TARGET_ONBOARDING.md` — adding a VPS safely.
- `docs/SECURITY_MODEL.md` — trust boundaries and threat model.
- `docs/OPERATIONS.md` — deployment, revoke, backup and recovery.
- `docs/ROADMAP.md` — intentionally deferred capabilities.
