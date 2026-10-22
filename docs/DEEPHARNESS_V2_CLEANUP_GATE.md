# DeepHarness V2 — Controlled cleanup gate (NO-GO for execution)

Status: design gate / NO-GO for destructive operations. Scope: existing Wandora MCP + DSH official runtime. Date: 2026-10-22.

## Operator intent
The owner wants to remove obsolete test workspaces, Leads, sessions and tasks while retaining **all** existing skills, models, provider configuration, and essential runtime state. The owner does not request an additional backup. A missing backup is **not** authorization to bypass loss-prevention checks.

## Verified official behavior
- `packages/api/workspace-controller/src/commands.ts`: `WorkspaceCommands.delete()` removes a workspace **registration only**, without deleting its directory or sessions. Do not present this as disk/session cleanup.
- `packages/skill/skill-filesystem/src/index.ts`: skill discovery traverses project `.dsh/skills`, `.agents/skills`, custom dirs, user DSH/Agents skill roots and bundled skills. Project-bound skills may live inside an otherwise disposable workspace.
- `packages/api/session-controller/src/skill-catalog.ts`: effective skill catalog depends on session cwd and agent preset. Do not assume global skill enumeration is complete.
- Existing eight `deepharness.platform` operations have no deletion API. Never implement cleanup by generic shell, arbitrary filesystem deletion, direct volume edits, or unsafe reuse of V1 Lead instruction.
- A real `dsh_list_workspaces` operation succeeded in another ChatGPT session, returning four workspaces and 19 sessions, but a subsequent read in this session failed with `deepharness_platform_agent_mesh_unavailable`. Reconcile current transport before enabling any mutation.

## Implementation plan / fail-closed contract
1. **Read-only inventory:** obtain official workspace IDs, session IDs, active status, Lead/team ownership, task references, presets and per-workspace skill roots. Return a candidate-only report; redact credentials. Probe actual configured DSH home, agents home, custom and bundled roots, without assuming defaults.
2. **Skill invariant:** detect every existing skill definition and resource directory from all roots; classify as shared vs project-scoped. If project-scoped skills would be affected, preserve/relocate them via an official, explicitly defined and separately tested workflow **before** allowing workspace directory removal. Missing, symlinked, ambiguous or unreadable skill locations => deny.
3. **Deletion semantics:** use documented official DSH APIs for archived sessions and registry changes. Determine whether there is an official durable session purge; if not, mark session disk cleanup unsupported rather than deleting JSONL/SQLite/volume files. `WorkspaceCommands.delete()` alone is deregistration, not purge.
4. **Scoped selection:** only independently inventoried exact IDs; never accept arbitrary absolute paths, wildcard patterns, root deletes or inferred ownership. Explicitly protect user skill roots, project skill trees, configs, credentials, volumes and active work.
5. **Two-phase action:** a dry-run produces canonical affected IDs and invariants; any destructive apply requires a short-lived, owner-confirmed exact digest/receipt tied to authenticated OAuth client/session, managed root and intended scope. Verify revocation, race safety and durable idempotency at commit.
6. **Postcondition:** readback official registries and skill catalog across representative workspaces/presets; count preserved skills and resolve content hashes/identities where appropriate. Abort or report partial failure without claiming success.
7. **Tests:** synthetic fixture with project-only skills, shared skills, active Lead, archived session, symlink escape, in-flight revoke, changed plan, duplicate request, I/O failure, and no-authority adversarial calls. Keep unrelated tools and V1 unchanged.

## Decision
Do not enable an MCP delete operation or run cleanup until these gates pass against the exact deployed DSH source revision. No merge, no deployment and no deletion as part of this document.
