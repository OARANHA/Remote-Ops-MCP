# DeepHarness read-only target — two-layer authorization gate

Status: **review proposal; NO deploy and NO privileges widened**. 2026-10-16.

## Verified current state

- Device `28server` is reachable through Agent Mesh; a dynamic target `deepharness-read` was created with `read-only` preset and `host_status` confirmed the correct hostname.
- `target_status(detail=full)` confirmed `allowedDockerContainers=[]`, `allowedDockerExecContainers=[]`, `allowedDockerExecPrograms=[]`, `allowedDockerActions=[]`.
- `docker_list` still surfaces only `supabase-db` from the underlying proxy allowlist. **No DeepHarness Docker access granted yet**.
- The current `target_agent_prepare` / `target_agent_apply` interface only accepts `target_id`, `device_id`, environment and a fixed preset. It has no parameter to set precise `allowedDockerContainers` and does not authorize widening.
- The local Docker proxy independently restricts allowed container names, even if a target registry is later updated. See `docs/OPERATOR_CAPABILITIES.md` and `docs/AGENT_ONBOARDING.md`.

## Requested minimum future read grant

Target registry `deepharness-read` may read metadata, state, sanitized inspect and bounded redacted logs for **exact** named containers:

```json
{
  "id": "deepharness-read",
  "transport": "agent",
  "environment": "production",
  "capabilityProfile": "read-only",
  "allowedDockerContainers": [
    "deepharness-web-1",
    "deepharness-mcp-grants-db-1"
  ],
  "allowedDockerExecContainers": [],
  "allowedDockerExecPrograms": [],
  "allowedDockerActions": [],
  "allowedWritePaths": [],
  "allowedProcessCwds": [],
  "allowedProcessPrograms": [],
  "allowedAdminPrograms": [],
  "allowedSemanticCapabilities": []
}
```

Note: the target must retain its authenticated device binding from the registry; this excerpt is **not** a complete deployable replacement or authority to overwrite `dynamic-targets.json`. Do not commit device credentials or copy the real device ID to public examples.

The **host-local** proxy also needs exactly these two names added to `ALLOWED_DOCKER_CONTAINERS`, preserving current entries used by other targets. Never use `*`, Docker socket bypass, or grant `ALLOWED_DOCKER_EXEC*` for this read-only target.

## Required engineering route

1. Implement a narrowly scoped, approval-gated **dynamic-target capability update** in the control plane, bound to an existing target/device and only exact authorized container names. Do not edit live registry JSON directly or implicitly elevate preset privileges; add negative unit tests proving existing targets unchanged, no wildcard and no unauthorized widening. Require explicit `APPROVE adm_...` for the exact policy diff.
2. In a **separate** approved host-local deployment, extend the Docker proxy read allowlist by the two exact container names, retaining `supabase-db` and any other previously authorized names. Verify proxy configuration, restart scope and rollback before applying.
3. Validate `docker_list`, `docker_health`, `docker_inspect_safe` and bounded sanitized `docker_logs` through `deepharness-read`; verify `docker_exec`, Docker actions and cross-project objects remain denied.
4. For any future diagnostic execution, add a **different** target/capability with a fixed no-shell program allowlist and an independent signed approval; do not broaden this read-only target.

## Go/no-go

GO now: code, CI and documentation review. NO-GO: altering the production proxy, broadening registry permissions, creating privileged Docker exec capabilities, or modifying the DeepHarness stack until the exact reviewed change and host-specific approval are obtained.
