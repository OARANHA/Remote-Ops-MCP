# ADR-0004 — Operator Chat Minimal Disclosure Policy V1

**Status:** Accepted for code-only qualification  
**Date:** 2026-09-27  
**Baseline:** Multi-VPS Capability Baseline V1 branch

## Context

Remote Ops MCP keeps detailed operational evidence in the repository, runtime, audit log and explicit diagnostic tool outputs. Operator chat should not repeat every raw allowlist/path/program by default when a concise authority summary is enough for a human decision.

The goal is smaller, safer and more legible operator conversations without weakening observability, auditability or explicit diagnostic access.

## Decision

1. Chat-facing target inspection is summary-first.
2. `target_status` returns a capability summary by default.
3. Exact allowlists remain available through explicit `target_status(detail="full")`.
4. `targets_list` remains concise and does not expose raw allowlists.
5. The target-apply chat response returns the applied logical target plus capability summary, not the full raw authority payload.
6. Raw evidence is not deleted or hidden from the authoritative runtime/audit/repository. It is surfaced when:
   - the user explicitly asks for it; or
   - a human decision requires exact operational detail.
7. Minimal disclosure is a presentation contract only. It does not change authorization, registry persistence, audit, redaction, host enforcement or capability semantics.

## Safety invariants

- Secret redaction remains unchanged.
- No decision may be made from a summary when exact allowlist detail is materially required; use `detail=full`.
- A concise summary must never imply more authority than the target has.
- No new durable state or disclosure database is introduced.
- Audit evidence remains complete under the existing audit contract.

## Effect boundary

Code and CI only. This ADR does not deploy Remote Ops MCP, alter a live target, revoke/expand authority or change a VPS.
