# ADR-0003 — Multi-VPS Capability Baseline V1

**Status:** Accepted for code-only qualification  
**Date:** 2026-09-27  
**Baseline:** `main@f2b94f3efe70082d42b45425ddfd568e6a0c72cd`

## Context

Remote Ops MCP already operates as the central capability-scoped control plane and already owns Agent Mesh device identity, Target Registry authority, target prepare/apply approval, per-target allowlists and host-local broker/proxy enforcement.

The next operational requirement is to govern Wandora, MedicsPro/28server and future VPSs without copying Wandora-specific authority or creating a second registry.

## Decision

1. Reuse the existing Agent Mesh + Target Registry authority model.
2. Treat `operator-workspace`, `read-only`, `postgres-readback` and `managed-admin` as portable capability baselines.
3. Keep one canonical pure preset builder shared by prepare/apply and tests.
4. Add a pure validator over authority-bearing `TargetConfig` fields. It has no persistence and performs no target mutation.
5. Keep device identity, registry target, OS permissions and local brokers/proxies independent per VPS.
6. The portable `operator-workspace` baseline grants no Docker/application authority.
7. Product-specific capabilities remain explicit later extensions reviewed per target.

## Capability Authority / Reuse Gate

- semantic/operator contract: Remote Ops MCP;
- durable authority: existing Target Registry + dynamic target overlay;
- host enforcement: existing agent execution broker, Docker proxy and optional managed-admin broker;
- replacement boundary: target/preset/broker configuration;
- no new registry, lifecycle, credential store, state machine or orchestration subsystem.

This preserves the Wandora ADR 0168 rule: portability is contract decoupling, not duplication of implementation.

## Validation

V1 must prove:

- the same baseline works for a Wandora target, MedicsPro/28server and a future arbitrary target;
- portable operator baseline has empty Docker authority;
- read-only and PostgreSQL readback remain narrower;
- managed-admin remains explicit and broker-backed;
- validation fails when authority is widened relative to the selected preset.

## Effect boundary

This ADR authorizes code and CI only. It does not deploy the control plane, create/update live targets, pair devices, widen permissions or alter any VPS.
