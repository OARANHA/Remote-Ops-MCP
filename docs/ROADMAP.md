# Roadmap

## Current — V1.1

- remote MCP over HTTPS;
- OAuth 2.1 + PKCE + Dynamic Client Registration;
- durable clients/sessions and rotating refresh tokens;
- immediate client/session/target revocation;
- admin console, usage and audit views;
- 19 read-only operational tools;
- Target Registry + SSH host-key pinning + capability allowlists;
- secret/path/output protections;
- Docker/Portainer deployment and GHCR CI pipeline;
- deterministic MOCK end-to-end validation.

## V1.2 candidates

- formal state-store interface with PostgreSQL implementation for multi-instance deployments;
- structured health history/latency per target rather than only last-seen state;
- operator identities/roles instead of one admin password;
- external identity-aware proxy integration documentation;
- Prometheus/OpenTelemetry metrics;
- signed export of audit evidence and configurable retention.

## Operator capability plane

V2 introduces a separate `operator` authority class rather than widening read-only tools. Filesystem writes, brokered process execution, bounded Docker exec/lifecycle operations and systemd lifecycle actions are each controlled by explicit per-target allowlists.

The Docker socket remains behind a local proxy with an independent host-side allowlist. Docker mutations require Agent Mesh transport. Empty operator allowlists fail closed.

Still intentionally deferred or requiring a separate contract:

1. unrestricted shell/root authority;
2. arbitrary Docker API forwarding;
3. privileged containers, mounts or environment injection through Docker exec;
4. generic package/system configuration mutation outside allowlisted workspaces;
5. deployment primitives without explicit pre/postcondition and rollback semantics;
6. cross-target shared credentials;
7. automatic privilege escalation.
