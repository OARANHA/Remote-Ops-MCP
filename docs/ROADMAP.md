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

## Write capability gate — intentionally deferred

Any mutating operational tool (`service_restart`, `docker_restart`, deployment, configuration write, etc.) is a new authority class. It should not be implemented as a small extension of an existing read-only tool.

Before any write plane is accepted, require:

1. explicit capability definition and threat model;
2. per-target allowlist;
3. idempotency key and replay rules;
4. precondition and postcondition verification;
5. bounded rollback strategy;
6. complete audit evidence;
7. human approval policy where consequences warrant it;
8. separate adversarial review.
