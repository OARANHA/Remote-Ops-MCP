# Operator capabilities

Remote Ops MCP operator targets are portable across VPSs. Operator authority is opt-in and fail-closed: every write or lifecycle capability must be enabled both in the target registry and, for Docker mutations, in the local Docker proxy.

## Multi-VPS Capability Baseline V1

The central Remote Ops control plane may govern Wandora, MedicsPro/28server and future VPSs through the same target contract. The baseline is deliberately **product agnostic**:

- one device identity per VPS;
- one logical target per authority boundary;
- capability authority remains the existing Target Registry plus host-local brokers/proxies;
- presets are reusable templates, not a second capability registry;
- a preset never inherits another target's application/container allowlists;
- `operator-workspace` grants only the standard agent workspace/process boundary and agent-service restart; Docker authority remains empty;
- `read-only` removes write/process/service mutation authority;
- `postgres-readback` grants only `postgres.pinned_readback`;
- `managed-admin` remains explicit, broker-backed and approval-gated.

`validateAgentTargetAgainstPreset(...)` is a code-only attestation helper. It does not mutate the registry and does not replace per-host OS/Docker policy.

Product-specific capabilities may be added later only through an explicit reviewed target change. They are not part of the portable baseline.

## Operator Chat Minimal Disclosure V1

Operator chat is a human control plane, not the raw evidence store.

- `targets_list` stays concise.
- `target_status` returns a decision-relevant capability summary by default.
- Use `target_status(detail="full")` when exact allowlists are explicitly requested or materially required for a human decision.
- Apply/prepare responses should report logical authority and bounded capability summaries rather than dumping full allowlists.
- Detailed evidence remains available from the authoritative repository/runtime and explicit full diagnostic views; the audit retains its existing redacted event contract. This policy does not weaken those sources.
- Minimal disclosure never changes authorization. If exact detail is required to validate a guardrail, request the full view and decide from that evidence.

## Target registry

An `operator` target may declare:

- `allowedWritePaths`: filesystem roots that can be changed.
- `allowedProcessCwds`: directories where broker processes may start.
- `allowedProcessPrograms`: host programs the execution broker may launch.
- `allowedDockerContainers`: containers visible to Docker read/lifecycle tools.
- `allowedDockerExecContainers`: narrower set of containers that accept `docker_exec`.
- `allowedDockerExecPrograms`: executable names accepted inside those containers.
- `allowedDockerActions`: any of `start`, `stop`, `restart`, `load_image`, `candidate_run`, `candidate_remove`.
- `allowedDockerImageLoadRoots`: roots from which a pre-staged `.tar` image may be loaded.
- `allowedDockerCandidateImagePrefixes`: image prefixes accepted for disposable candidates.
- `allowedDockerCandidateNetworks`: Docker networks accepted for disposable candidates.
- `allowedDockerCandidateNamePrefixes`: container-name prefixes accepted for disposable candidates.
- `allowedDockerCandidateHostPorts`: loopback host ports accepted for disposable candidates.
- `allowedDockerCandidateContainerPorts`: container ports accepted for disposable candidates.
- `allowedServices`: systemd units visible to service tools.
- `allowedServiceActions`: any of `start`, `stop`, `restart`, `reload`.
- `allowedSemanticCapabilities`: narrow semantic operations that do not inherit generic process/Docker authority.
- `allowedAdminPrograms`: root programs accepted by the signed managed-admin flow.
- `allowedAdminCwds`: working-directory roots accepted by the signed managed-admin flow.

Empty lists deny the capability. A target must use `capabilityProfile: "operator"` for mutation tools.

Example:

```json
{
  "id": "customer-agent",
  "deviceId": "dev_REPLACE_ME_1234",
  "transport": "agent",
  "capabilityProfile": "operator",
  "allowedWritePaths": ["/opt/customer/ops-workspace"],
  "allowedProcessCwds": ["/opt/customer/ops-workspace"],
  "allowedProcessPrograms": ["git", "node", "npm", "python3", "curl", "jq"],
  "allowedDockerContainers": ["customer-web"],
  "allowedDockerExecContainers": ["customer-web"],
  "allowedDockerExecPrograms": ["customer-cli"],
  "allowedDockerActions": ["restart", "load_image", "candidate_run", "candidate_remove"],
  "allowedDockerImageLoadRoots": ["/opt/customer/ops-workspace"],
  "allowedDockerCandidateImagePrefixes": ["customer/web:candidate-"],
  "allowedDockerCandidateNetworks": ["customer-core"],
  "allowedDockerCandidateNamePrefixes": ["customer-web-candidate-"],
  "allowedDockerCandidateHostPorts": [18090],
  "allowedDockerCandidateContainerPorts": [8080],
  "allowedServices": ["customer-agent.service"],
  "allowedServiceActions": ["restart"]
}
```

## Docker proxy

The host agent never receives unrestricted Docker socket access. A local proxy remains the Docker authority boundary.

Configure the proxy with the superset that the host is allowed to expose:

```text
ALLOWED_DOCKER_CONTAINERS=customer-web,customer-worker
ALLOWED_DOCKER_EXEC_CONTAINERS=customer-web
ALLOWED_DOCKER_EXEC_PROGRAMS=customer-cli
ALLOWED_DOCKER_ACTIONS=restart,load_image,candidate_run,candidate_remove
ALLOWED_DOCKER_IMAGE_LOAD_ROOTS=/opt/customer/ops-workspace
ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES=customer/web:candidate-
ALLOWED_DOCKER_CANDIDATE_NETWORKS=customer-core
ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES=customer-web-candidate-
ALLOWED_DOCKER_CANDIDATE_HOST_PORTS=18090
ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS=8080
```

The target registry can only reduce this authority further.

When the Docker proxy itself runs in a container, every configured image-load root must also exist inside that proxy container. The production Compose contract therefore bind-mounts the governed root read-only, using `DOCKER_IMAGE_LOAD_ROOT_HOST` for the host source and `DOCKER_IMAGE_LOAD_ROOT_CONTAINER` for the in-proxy path. The value exposed through `ALLOWED_DOCKER_IMAGE_LOAD_ROOTS` must refer to the in-proxy path. On Wandora hosts both default to `/opt/wandora/ops-workspace`, preserving the same absolute path on both sides of the read-only bind.


`docker_exec` does not accept shell text, environment overrides, user overrides, privileged mode, working-directory overrides, mounts or arbitrary Docker API requests. It accepts a container, one program name and an argv array. Output is bounded and redacted before returning to the MCP client.


## Disposable candidate lifecycle

The existing `docker_action` tool may expose three additional actions only when both the target registry and the host-local Docker proxy allow them:

- `load_image`: load an already-staged `.tar` from an allowlisted root. It cannot pull from a registry or accept an arbitrary upload.
- `candidate_run`: create/start a disposable container with no mounts, no env override and no privileged mode. It binds only to `127.0.0.1`, and image prefix, network, name prefix, host port and container port are all independently allowlisted.
- `candidate_remove`: force-remove only a container whose name matches an allowlisted candidate prefix. Missing candidates are treated as already absent.

These actions are intended for pre-production qualification. They do not authorize Compose/project promotion, stack edits, environment-file reads or arbitrary Docker API access.

## Pinned PostgreSQL verifier readback

For release-proof cases where the MCP needs to prove a production PostgreSQL contract without exposing a database shell, use a separate Agent Mesh target with the `postgres-readback` preset.

That target grants only:

```text
allowedSemanticCapabilities = ["postgres.pinned_readback"]
capabilityProfile = read-only
generic docker exec = denied
generic process execution = denied
filesystem write = denied
```

Before installing the proxy on an already-paired host that predates the PostgreSQL readback capability, stage and build an exact repository revision, then run `install-agent-postgres-readback-runtime.sh` with `WANDORA_EXPECTED_REVISION=<40-char-sha>`. That installer updates only the three runtime artifacts required by this capability (`dist/agent/operations.js`, `dist/docker/read-proxy.js`, `dist/docker/postgres-readback.js`), backs up the previous files, restarts only `wandora-ops-agent.service`, and rolls back automatically on failure. It deliberately does **not** modify pairing state, the execution broker unit/binary, the target registry, Docker configuration, or database state.

The host-local proxy must be installed explicitly with `install-agent-postgres-readback-proxy.sh`. Its root-owned configuration pins:

- the exact PostgreSQL container;
- container execution user;
- database/user names;
- verifier id → SHA-256 mappings.

The MCP tool receives `verifier_id` plus the exact canonical verifier file content. Both control plane and proxy remain typed; the proxy computes SHA-256 over that unmodified payload and rejects anything that does not exactly match the approved verifier. Only after the hash matches, the adapter may remove the exact standalone client directives `\\set ON_ERROR_STOP on` and `\\pset pager off`, because their behavior is already enforced by fixed non-interactive argv; every other psql meta-command fails closed. It then runs fixed `psql` arguments with `default_transaction_read_only=on`, explicit `BEGIN TRANSACTION READ ONLY` and bounded timeouts. The caller cannot select container, DB credentials, exec user, environment or arbitrary argv.

This capability is **readback only**. Applying a migration requires a different capability and a separate approval/review.

## Signed managed-admin

For hosts that should be operable without returning to SSH for routine root administration, use the explicit Agent Mesh managed-admin bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/main/install-agent.sh | sudo bash -s -- --managed-admin
```

The default installer remains least-privilege. The flag additionally installs `wandora-ops-admin-broker.service` as root. The ordinary `ops-mcp` agent is **not** added to `sudo` or the Docker group.

The authority chain is:

```text
MCP OAuth/session
  -> host_admin_prepare (no execution)
  -> user echoes exact APPROVE adm_...
  -> host_admin_apply
  -> <= 2 minute Ed25519-signed one-time ticket
  -> authenticated Agent Mesh device
  -> local root broker
  -> exact program + argv, shell=false
```

The signing private key is derived inside the control plane from the existing `AUTH_SECRET`. The host receives only the public verification key over HTTPS. A compromised unprivileged agent therefore cannot mint new root tickets. The root broker also verifies the paired `device_id`, ticket expiry, persistent nonce replay state, local cwd roots and local program allowlist.

The `managed-admin` target preset is fail-closed:

- it can only be prepared for a live Agent Mesh device currently advertising `host.managed_admin`;
- the device advertises that capability only when the local broker socket exists;
- the target registry and root broker both enforce program/cwd allowlists;
- the default program set deliberately excludes shells, interpreters, `sudo`, `su` and `pkexec`;
- command output is bounded and still passes through normal MCP secret redaction/audit;
- each approval is actor-bound, single-use and expires if not applied.

This profile is intended to cover routine administrative work such as package management, systemd, Docker Compose, deployment file installation, ownership/mode changes, networking/firewall commands and host configuration. It is not a general root shell. A future break-glass shell, if ever added, is a separate capability and must not be smuggled into this preset.

Rollback is deliberately narrow: `sudo bash /opt/wandora/remote-ops-agent/uninstall-agent-managed-admin-broker.sh` removes only the root broker, local verification key and replay state. Pairing, the ordinary execution broker and workspace remain intact. The corresponding managed-admin target should then be revoked/disabled in the control plane. Once the broker socket disappears, the device stops advertising `host.managed_admin` and the capability fails closed.

## Service actions

`service_action` is additionally constrained by normal operating-system permissions. Listing an action in the target registry does not grant sudo or bypass systemd/Polkit.

For a VPS that needs service mutations, grant the agent OS identity only the precise units/actions required by that host. Do not add the agent to broad privileged groups.

## Recommended profiles

- Observation target: `read-only` or `prod-read-mostly`.
- Operator target: Agent Mesh + isolated execution broker + explicit per-capability allowlists.
- Managed-admin target: explicit `--managed-admin` bootstrap + signed root broker + `managed-admin` target preset + per-action `APPROVE adm_...`.
- Keep a separate read-only target when production observation should remain independent of mutation authority.

## Cross-VPS onboarding

Each VPS should have its own device identity, registry target, workspace, Docker proxy allowlists and OS-level permissions. Do not copy device credentials or operator secrets between VPSs.
