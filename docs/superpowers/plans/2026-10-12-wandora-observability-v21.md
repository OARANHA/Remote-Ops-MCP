# Wandora MCP V2.1 Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, deterministic, offline-tested observation contract and normalization engine from existing authorized host readings, without exposing new live MCP capabilities.

**Architecture:** Introduce small pure TypeScript modules for validation, normalization, health evaluation and aggregation. Keep target authority in the existing registry/OAuth/Agent Mesh; a future adapter consumes authorized read results only. Avoid background polling, persistence, arbitrary network probes or shell execution in this plan.

**Tech Stack:** TypeScript, Node.js >=22, existing Zod dependency, Node `node:test`, npm, existing GitHub CI (not modified by default).

**Spec:** `docs/superpowers/specs/2026-10-12-wandora-observability-design.md`

**Authorization:** ADM-001, 2026-10-12: **plan preparation only**. This document is NOT permission to execute the steps, merge, deploy, restart services or alter VPS.

## Global Constraints

- Repository: `OARANHA/Remote-Ops-MCP`; baseline `main@235fd9359cbf56e5aa7cf46c3f0fe224ee242cdd`, reconcile fresh main/PRs before executing.
- Preserve OAuth, target registry, Agent Mesh, signed broker, security redaction, audit and existing 60+ tool contracts; no second registry or authority.
- No live MCP tool registration, scheduler, polling, historical persistence, provider API operations, credential use, deployments or production mutations.
- Use a separate isolated worktree/branch after a **new ADM approval** to implement. Do not overwrite concurrent DSH branches/PRs.
- Only treat CPU/network percentages as valid when a documented measured denominator and interval exist; exclude their percentage health evaluation in the first slice.
- Unknown/stale/future/invalid data must never appear green, and error responses must not leak host/IP/secrets.

## Review Focus

1. Distinct `targetId` and metric key collisions: reject duplicates and unrecognized names; test in Task 1.
2. Non-finite numbers, zero total memory, localized/nonstandard `free` or `df` output: return unknown without throwing or executing shell; test in Task 2.
3. Future timestamps and invalid timestamps wrongly conflated with stale data: explicit `future`, `invalid`, `stale`; test in Task 3.
4. Critical findings masking unknown/unavailable coverage: preserve counts and independent completeness; test in Task 4.
5. Unauthorized/revoked/offline target and leaking raw adapter errors: no sampling, no raw output; test in Task 5.

---

### Task 1: Strict observation contract and validation (offline)

**Files:**
- Create: `src/observability/contracts.ts`
- Create: `test-observability-contracts.mjs`

**Interfaces:**
- Produce: `type ObservationSource = "agent"|"ssh"|"provider"`, `type MetricUnit = "percent"|"bytes"|"bytes_per_second"|"count"`, `type HealthLevel = "ok"|"warn"|"crit"|"unknown"`, `type ObservedMetric`, `type Observation`.
- Produce: `parseObservation(input: unknown): Observation` (throws typed safe validation error, never includes raw input in error).

- [ ] **Step 1: Write failing tests** for bounded `metrics`, allowlisted metric IDs, duplicate (`targetId`, `name`) keys, no host/IP fields in accepted schema, negative/NaN/infinite values, unsupported units, malformed timestamps and valid partial/unavailable snapshots.
- [ ] **Step 2: Run** `npm run build && node --test test-observability-contracts.mjs`; expected RED (module absent or failed assertions).
- [ ] **Step 3: Implement** `parseObservation(input: unknown): Observation` with strict Zod schema and explicit unit-compatible metric IDs; bound collection size and strings; reject unauthorized additional properties.
- [ ] **Step 4: Run** the Task 1 tests; expected GREEN after implementation.
- [ ] **Step 5: Review** dependency graph: no filesystem/network/process/target registry imports.
- [ ] **Step 6: Commit** `feat(observability): add strict offline observation contract` in isolated feature branch (only after implementation ADM).

### Task 2: Pure host reading normalizers

**Files:**
- Create: `src/observability/normalize-linux.ts`
- Create: `test-observability-normalize-linux.mjs`

**Interfaces:**
- Consume: validated metric contract from Task 1.
- Produce: `normalizeMemoryFreeB(text: string, capturedAt: string): ObservedMetric[]`; `normalizeDiskDfHP(text: string, capturedAt: string): ObservedMetric[]`.
- Both accept raw *captured* string fixtures only; no shell calls, no target discovery.

- [ ] **Step 1: Write failing tests** for `free -b` valid Mem total/available, zero total, malformed localized heading, missing columns, negative values and bounded length; `df -hP` header parsing, valid Use% integer, pseudo filesystems excluded by documented name/class, duplicate mount handling, spacing and malicious text.
- [ ] **Step 2: Run** `npm run build && node --test test-observability-normalize-linux.mjs`; expect RED.
- [ ] **Step 3: Implement** above pure functions, with explicit memory percent formula `100*(total-available)/total` only when `total>0`, values finite and `0<=available<=total`. No fabricated CPU/network utilization.
- [ ] **Step 4: Run** focused tests; expect GREEN; manually review that arbitrary raw text does not appear in returned errors.
- [ ] **Step 5: Commit** `feat(observability): normalize approved Linux read fixtures` after ADM.

### Task 3: Correct health evaluation prototype

**Files:**
- Modify: `src/observability/health-policy.ts`
- Modify: `test-observability-foundation.mjs`

**Interfaces:**
- Produce: `evaluateMeasurement(sample: Measurement, options?: EvaluationOptions): HealthFinding` with precise unknown reasons, injected `now`.
- Reject `network` percentage utilization until explicit bandwidth capacity is defined; future implementation can use a distinct bytes_per_second signal with a separately reviewed absolute threshold.

- [ ] **Step 1: Write failing tests** for future vs stale vs invalid timestamps, wrong metric units, invalid percentage range, threshold boundary values, unknown signal, frozen clock, absent values and misconfigured thresholds.
- [ ] **Step 2: Run** `npm run build && node --test test-observability-foundation.mjs`; expect RED for added test cases.
- [ ] **Step 3: Implement** minimal policy fixes; align types with Task 1 and explicitly remove provisional network-percent default health assumption.
- [ ] **Step 4: Run** focused tests; expect GREEN.
- [ ] **Step 5: Commit** `fix(observability): refuse unsupported percentages and split freshness errors` after ADM.

### Task 4: Aggregate completeness and bounded per-target report

**Files:**
- Create: `src/observability/aggregate.ts`
- Create: `test-observability-aggregate.mjs`

**Interfaces:**
- Consume: `Observation` and `HealthFinding`.
- Produce: `summarizeTargetObservations(observations: readonly Observation[]): TargetHealthSummary[]` with `counts`, `level`, `completeness`, and deterministic ordering.

- [ ] **Step 1: Write failing tests** for empty input, partial/unavailable source, one critical plus one unknown, duplicate observations, stale data, cross-target isolation, deterministic sort and signal coverage.
- [ ] **Step 2: Run** `npm run build && node --test test-observability-aggregate.mjs`; expect RED.
- [ ] **Step 3: Implement** pure aggregation with no raw host fields; fail closed on inconsistent source/timestamps and preserve unknown counts rather than overwriting with green.
- [ ] **Step 4: Run** focused tests; expect GREEN.
- [ ] **Step 5: Commit** `feat(observability): aggregate health with explicit completeness` after ADM.

### Task 5: Authorized adapter boundary (offline mock only)

**Files:**
- Create: `src/observability/authorized-adapter.ts`
- Create: `test-observability-authorized-adapter.mjs`

**Interfaces:**
- Produce: `type AuthorizedRead = (logicalTargetId: string, operation: "host.memory"|"host.disk_usage") => Promise<string>`.
- Produce: `buildObservationFromAuthorizedReads(input: {targetId: string; source: "ssh"|"agent"; capturedAt: string; authorize: (targetId: string)=>Promise<boolean>; read: AuthorizedRead}): Promise<Observation>`.
- Both callbacks are injected test doubles. No direct call into the production gateway or new grant of authority.

- [ ] **Step 1: Write failing tests** verifying authorization callback always precedes reading; denied/revoked path performs zero reads; thrown credential-bearing error gets sanitized; partial read errors become partial/unknown rather than OK; no hostnames/IP in errors.
- [ ] **Step 2: Run** `npm run build && node --test test-observability-authorized-adapter.mjs`; expect RED.
- [ ] **Step 3: Implement** injection-only adapter using pure normalizers; never introduce new target registry or bypass central authorization.
- [ ] **Step 4: Run** focused tests; expect GREEN.
- [ ] **Step 5: Commit** `feat(observability): add mock-only authorization-aware adapter` after ADM.

### Task 6: Verification gate and review handoff (no runtime integration)

**Files:**
- Modify: `docs/decisions/ADR-0004-OBSERVABILITY-FOUNDATION-CODE-ONLY.md` (still proposed until separately accepted)
- Modify: `docs/OBSERVABILITY_BACKLOG.md` (mark only verified completed slices after execution)
- Add: `docs/observability/VERIFICATION.md` (only once evidence exists)

**Interfaces:** none; documentation and evidence only.

- [ ] **Step 1: Run** `npm ci` in a disposable local workspace; record environment/lockfile provenance (no production).
- [ ] **Step 2: Run** `npm run build`, focused tests T1–T5 and existing `npm run check`; record counts and full failures honestly.
- [ ] **Step 3: Scan diff** for imports of `child_process`, `net`, `fs`, `src/tools/index.ts`, OAuth/registry modifications, generated artifacts, secrets and deployment settings; expected none for offline modules.
- [ ] **Step 4: Validate** main freshness, DSH PR conflict surface, GitHub CI status; no merges.
- [ ] **Step 5: Request** JEV adversarial completion review (advisory) plus actual human reviewer; do not equate JEV probability with test evidence.
- [ ] **Step 6: Update** docs with exact observed checks; keep PR draft until a separate ADM decision.
- [ ] **Step 7: Commit** `docs(observability): record code-only verification evidence` after ADM.

## Deferred design gates — NOT executable tasks in this plan

- Runtime MCP observation tools or integration with active target registry: requires separate spec, security review, ADM and tests.
- Continuous collection/history: explicit storage schema, TTL, retention quotas, revocation semantics and persistence budget.
- HTTP/TCP probes: allowlist, DNS rebinding/SSRF policy, per-target approval, rate limits.
- Alerting/webhooks/Observatório: privacy/data-minimization and idempotent delivery contracts.
- Backups, certificate renewal, firewall, cron, Contabo provider writes: separate authority/scopes/approval design.

## Completion criteria

The future implementation is **code-complete** only when T1–T6 tests are executed green, new pure modules are audited, no live tool behavior has changed, and draft PR accurately states scope. **Runtime readiness and deployment are separate authorizations**. No command in this plan should be executed under ADM-001, which authorizes planning only.
