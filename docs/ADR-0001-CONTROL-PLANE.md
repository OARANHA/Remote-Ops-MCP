# ADR-0001 — Durable OAuth and revocable remote-operations control plane

**Status:** Accepted  
**Version:** Remote Ops MCP V1.1

## Context

The first prototype proved that a remote MCP gateway could expose a bounded, read-only operations surface over SSH. Its OAuth clients, authorization codes and refresh tokens were held only in process memory. That created three production problems: authorization disappeared after a container restart, a previously issued JWT could not be revoked immediately, and there was no operator view of connected clients/targets.

The control plane must remain materially less powerful than SSH itself. Operational convenience must not introduce arbitrary shell execution, expose target credentials, or let a runtime toggle grant authority that the static target registry did not already grant.

## Decision

1. Keep the static target registry as the capability authority for hosts, SSH identities and allowlists.
2. Add a small durable state store for OAuth clients, authorization-code hashes, session/refresh-token hashes, runtime target controls, usage and last-seen data.
3. Issue access tokens with a client id (`cid`) and session id (`sid`). Verify the JWT signature **and** verify that the persisted client/session remain active on every authenticated MCP request.
4. Store authorization codes and refresh tokens only as SHA-256 hashes. Rotate refresh tokens on every refresh grant.
5. Runtime target controls are an overlay that may disable an enabled registry target, but may never enable a target disabled by the registry.
6. Closing/revoking a target also closes its pooled SSH connection.
7. Add a separate `/admin` operator console with an independent `ADMIN_PASSWORD`, signed HttpOnly/SameSite cookie and CSRF protection for every mutation.
8. Do not render SSH hostnames/IP addresses, SSH usernames, key paths or raw secrets in the admin UI.
9. Keep the service single-active-instance for V1.1. The durable state implementation uses atomic file replace and process-local serialization rather than pretending to be a multi-writer database.
10. Keep all MCP operational capabilities read-only. A future write plane requires a new ADR and capability contract.

## Why a JSON state file first

The service is intentionally small and deployed as one active container. A JSON store using atomic rename has no native database dependency, is easy to back up, and is sufficient for the expected control-plane volume. This is a deliberate scope choice, not a claim that a JSON file is appropriate for active/active replicas.

If active/active, multi-region or high write volume becomes a requirement, the state interface can move to PostgreSQL without changing the MCP capability surface.

## Consequences

Positive:

- container restarts no longer disconnect every connector;
- a session/client/target can be revoked immediately;
- refresh tokens are long-lived without being stored in clear text;
- operators have a small auditable control console;
- the static registry remains the upper bound of authority.

Trade-offs:

- only one active application instance may write the V1.1 state file;
- the data volume is intentionally bounded and the audit log requires rotation/retention at the host layer;
- losing `AUTH_SECRET` invalidates all access/admin cookies; losing the state file invalidates durable OAuth sessions.
