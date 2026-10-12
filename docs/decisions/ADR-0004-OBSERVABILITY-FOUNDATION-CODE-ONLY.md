# ADR-0004 — Observability foundation without deployment

**Status:** Proposed — code-only, no tool exposure, no authority change
**Date:** 2026-10-12
**Base:** main@235fd9359cbf56e5aa7cf46c3f0fe224ee242cdd

## Context
We want to learn from Webdock's historical metrics, warning overviews, alerts, and event tracking without copying its cloud-vendor-specific administration API or replacing the existing Remote-Ops control plane. Main has existing OAuth, Agent Mesh, target registry, audit, operator tools, managed-admin approvals, Portainer and OpenHands. Several parallel DSH/OpenHands PRs are open. Implementing a new monitoring daemon, privileged process, credential store or target registry would violate the current reuse gate.

## Decision proposal
1. Begin with **pure offline health evaluation** and tests only. The implementation in `src/observability/health-policy.ts` is **not wired to `src/tools/index.ts`**, agents, admin routes, scheduler or runtime. It cannot change live behavior.
2. When integration is later authorized, reuse the **existing target registry**, target enabled/revoked state, actor identity, audit and per-target capability rules. Fail closed for revoked/offline targets.
3. Do not presume the current host status calls return time series. Temporal histories require an explicit data model and bounded storage with retention. Read host metrics only through existing capability-scoped adapters.
4. **unknown** is a first-class state. Missing, stale, invalid or future samples must not appear green. Aggregate severity prioritizes crit, warn, unknown, then ok; the output must retain unknown counts.
5. No default external HTTP probes, no arbitrary URL/port inputs, no network calls in the baseline.
6. Later writes (cron, backups, cert renewal, scripts, firewall, DNS and cloud-provider operations) require separate ADRs, source-of-authority classification, `prepare/apply` approvals and host-local enforcement. Never infer permissions from MCP annotations alone.
7. No changes to deployments, running services, OAuth clients, credentials, production target overlays, GitHub workflows or main branch in this slice.

## Proposed phased capabilities (not implemented)
- V2.1a: normalized inventory and pure health evaluation.
- V2.1b: bounded sample ingestion, timestamp validation, history and retention, only after storage/authority design.
- V2.1c: authorized HTTP/TCP probes with endpoint allowlists and SSRF defenses.
- V2.1d: event correlation, deduplication, warning rules and reporting.
- V2.2: governed backup and automation contracts.
- V2.3: isolated Contabo provider integration, scoped to cloud API authority; no generic shell or runtime dynamic authority.
- V3: Observatório event export with explicit consent, data minimization and idempotent delivery.

## Evidence and validation
- `npm run build` and `node --test test-observability-foundation.mjs` are the required offline checks.
- Test invalid values, missing values, stale timestamps, future timestamps, threshold boundaries, aggregate unknown, empty input and misconfigured thresholds.
- Review code for host imports, network, subprocess, filesystem and MCP registration before enabling it.
- Never interpret a successful code-only CI as a production deployment authorization.

## Open questions
- Metrics source and polling ownership; expected sampling and maximum storage.
- How does monitoring behave when an Agent Mesh device is disconnected or the target is revoked?
- Which HTTP endpoints may be probed? Who approves and rotates allowlists?
- What is the observability retention/audit minimization policy?
- Which provider API features are actually available to Contabo accounts?
- Which Observatório ingestion contract is canonical at integration time?
