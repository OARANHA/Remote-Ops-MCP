# Wandora MCP V2.1 — Observability Contracts (Design Specification)

**Status:** Proposed specification, user-approved conversational design on 2026-10-12; written specification awaits separate user review.
**Repository:** OARANHA/Remote-Ops-MCP
**Branch:** feat/ops-observability-foundation-no-deploy-20261012 (PR #64, draft)
**Baseline:** main@235fd9359cbf56e5aa7cf46c3f0fe224ee242cdd
**Hard boundary:** CODE/DOCS ONLY. No merge, deployment, live target updates, scheduler activation, credential access, or VPS operations.

## 1. Intent and scope

Evolve the existing capability-scoped Remote Ops MCP toward consistent, auditable multi-VPS health observations without replacing its trusted control plane. Initial V2.1 work focuses on a strict **read-only observation contract and deterministic evaluation**. Historical persistence, active probes, webhook delivery and writes are distinct later reviews and gated implementation slices.

### Included in the V2.1 design
- A normalized observation envelope with explicit source, capture time, metric units, and completeness.
- Typed, bounded parsing/normalization of existing authorized Linux observations.
- Pure deterministic health evaluation and aggregate reporting, preserving unknown/missing states.
- A future adapter boundary for authorized read-only tools without duplicating target or session authority.
- Offline fixtures/tests, no privileged code or additional dependencies required for the first slice.

### Excluded pending separate design/approval
- Runtime MCP tool exposure, background polling/cron, data storage or retention implementation, HTTP/TCP probes, alert notification, Observatório export, Contabo cloud writes, backups, SSH administration and auto-remediation.
- Any claim that current raw `/proc/loadavg` is CPU usage percent, or that cumulative network bytes are percentage utilization.

## 2. Canonical authority and existing contracts

The existing control plane is authoritative for OAuth/session and actor identity, target enable/revoke and capability policy, existing Agent Mesh/SSH transport, audit, and host-local enforcement. Do not create a second target registry, broker, credential store, authorization oracle, remote command runner or root daemon. New code must never elevate authorization from the presence of a metric or a tool annotation.

Existing source paths:
- `src/config/targets.ts` — registry and typed target definitions.
- `src/tools/index.ts` — current tool definitions, including `host_status`, `disk_usage`, `memory_status`, `runtime_summary`.
- `src/agent/operations.ts` — bounded host observations using `/proc/loadavg`, `df -hP`, `free -b`, `uptime`.
- `src/observability/health-policy.ts` (PR #64) — **prototype**, not an accepted unit contract.
- `docs/ADR-0003-MULTI-VPS-CAPABILITY-BASELINE.md` — authority/reuse restrictions.
- `docs/decisions/ADR-0004-OBSERVABILITY-FOUNDATION-CODE-ONLY.md` (PR #64) — proposed, not accepted.

## 3. Options evaluated

**A — Recommended: normalize existing read data with pure functions first.**
Pros: minimal privilege, testable offline, reuse existing authorization and transports, low conflict risk with in-flight DSH PRs. Cons: no full network/CPU historical coverage until measurement primitives are reviewed.

**B — Extend host Agent Mesh immediately with a background metrics collector.**
Pros: eventual richer CPU/network measures. Cons: impacts live agent protocol, collection lifecycle and persistent resource consumption; explicitly excluded from the current approved stage.

**C — Put provider-cloud monitoring (Webdock/Contabo) at the center.**
Pros: provider metrics and inventory. Cons: vendor-coupling, uneven capabilities and duplicated trust domain; keep as later optional adapter only.

Decision: A; do not silently pursue B or C.

## 4. Proposed data contract

The following is a design-level shape; precise Zod/TypeScript implementation and naming are subject to plan and tests.

```ts
type ObservationSource = "agent" | "ssh" | "provider";
type ObservationStatus = "complete" | "partial" | "unavailable";
type HealthLevel = "ok" | "warn" | "crit" | "unknown";
type MetricUnit = "percent" | "bytes" | "bytes_per_second" | "count";

interface ObservedMetric {
  name: string; // allowlisted semantic metric ID, not arbitrary labels
  value: number | null; // finite and nonnegative if non-null
  unit: MetricUnit;
  status: HealthLevel;
  reason?: "measured" | "missing" | "invalid" | "stale" | "future" | "unsupported";
}
interface Observation {
  targetId: string; // existing logical registry ID only; no hostnames/IPs
  capturedAt: string; // ISO-8601 UTC timestamp; date parsing validated
  source: ObservationSource;
  metrics: ObservedMetric[]; // allowlisted names, bounded cardinality
  completeness: ObservationStatus;
}
```

Implementation boundaries:
- `targetId` belongs to a previously authorized target, and is not accepted as proof of authorization.
- Source values represent evidence provenance; never manufacture observations from unavailable sources.
- Invalid, missing, future-dated or stale samples must evaluate `unknown`. If a sample is absent, reports must preserve its missing identity without fabricating a healthy value.
- Treat percent and byte metrics separately. Network requires explicit counter sampling interval for bytes/second; network percentage is prohibited until an independently verified link-capacity denominator exists.
- CPU percentage requires two valid cumulative CPU tick samples with a positive time interval. Current `loadavg` is not CPU percent.
- For memory, define an explicit utilization formula (e.g., `(MemTotal - MemAvailable)/MemTotal` where valid); `free -b` parse requires test fixtures for locale, malformed inputs, zero total and edge cases.
- For disk, `df -hP` gives humanized sizes and percentage; prefer validated `Use%` where applicable, but reject header/footer noise, pseudo-filesystems and duplicate mounts according to a documented selection rule. Later prefer machine-readable `df -B1 -P` behind authorized existing adapter after design review.
- Snapshots do not become a time series simply because one call returns an uptime or memory value.

## 5. Evaluation and aggregation

Thresholds operate only on verified percentages and signal-specific configured boundaries. They must be strictly ordered `0 <= warn < crit <= 100`. Proposed default thresholds in PR #64 are provisional, not production policy.

For a target summary: explicit finding counters `ok/warn/crit/unknown`; severity priority `crit > warn > unknown > ok`, with a separate completeness flag to prevent a critical finding from hiding missing signals. Empty sample sets are `unknown/unavailable`. Metrics from different times must not be conflated into a single fresh observation.

Fail closed on malformed metric shapes, non-finite values, impossible percentages, bad timestamps, duplicate identifiers, unsupported units, cardinality overflow or unsupported signal names. A denied/revoked target must not yield an availability leak or identify underlying IP, credentials, hostname or device identity.

## 6. Data flow and error boundaries

1. Authorized request arrives at existing MCP OAuth control plane and is scoped to an enabled target.
2. Existing transport executes a read-only allowlisted host operation (later integration slice; not part of current prototype).
3. Adapter receives bounded result, normalizes typed units and timestamp, and strips all raw host/network identifiers before creating the observation envelope.
4. Pure evaluator computes metric health; aggregator retains unknown counts and unavailable coverage.
5. Response is sanitized using established redaction paths; existing MCP audit logs a minimal action outcome, not full raw metrics. No temporal storage, notifications or outbound probes in this slice.

Errors: invalid sample => explicit unknown with reason, not success. Transport failures => existing safe error semantics; do not accidentally translate permission-denied into “host offline”. Revocation => fail closed. Logs must not include raw command output.

## 7. Security, performance and test requirements

- Pure parsing/evaluation modules: no network, filesystem, process execution, credentials, host imports or MCP registration.
- Bounded arrays/string lengths and deterministic ordered aggregation; no user-supplied URL/port/shell text.
- Reuse existing `src/security/redact.ts` where integration is eventually authorized.
- Idempotent evaluation for identical input and explicit injected `now` in tests.
- Offline tests: missing/null/NaN/infinite, out-of-range, warn/crit boundaries, malformed/future/stale timestamps, time ordering, duplicate metric names, nonexistent mount data, zero totals, inconsistent units, partial transport data, empty inputs, correct aggregate completeness and no disclosure.
- Run `npm ci`, `npm run build`, `node --test test-observability-foundation.mjs` in a disposable non-production workspace; do not mark green until observed.
- Verify compatibility against existing CI/check suite and current `main` and concurrent PRs before any later integration.

## 8. Candidate implementation slices (NOT YET AUTHORIZED)

| Slice | Independent testable result | Effect boundary |
| --- | --- | --- |
| T1 | Versioned observation types and strict local validator | Offline only |
| T2 | Pure `free -b` and disk normalization with hostile fixture tests | Offline only |
| T3 | Health thresholds/freshness/unknown semantics, including network% removal | Offline only |
| T4 | Per-target aggregation with explicit completeness | Offline only |
| T5 | Read-only adapter design bound to existing policies (no MCP registration yet) | Offline mock first |
| T6 | Future authorized MCP read integration, only after separate acceptance | No scheduled polling |
| T7 | Historical storage/retention, rules and events only after new design/approval | Excluded here |
| T8 | Future Observatório export or Cloud/Contabo adapter only after separate review | Excluded here |

## 9. Adversarial decisions and unresolved gates

JEV v1.13.0 routed this design to `deep_review` (approx. 0.63 candidate probability), advisory only; no automatic authorization. Challenges:
1. Network-percent threshold in PR #64 has no sourced denominator; must be removed/redefined before use.
2. CPU load average and per-interval percent are distinct metrics; no invented derivation.
3. Current `df -hP` precision and per-mount selection need a fixed contract.
4. Unknown is an evidence state and not a green operational status, including under critical/warn aggregation.
5. No historical collection/storage until retention and revocation semantics are agreed.
6. Keep PR #64 draft isolated from #49–#57 and avoid changes to production.

## 10. Approval and handoff

The user approved the **conversational V2.1 architecture** on 2026-10-12. This written specification is submitted for **separate user review** per Superpowers architectural process. Written-spec acceptance is required before creating a task-level plan; the plan itself then requires review and an explicit execution mode before implementation. No new implementation work is authorized by approval of the conversational design alone.
