# Operator capabilities

Remote Ops MCP operator targets are portable across VPSs. Operator authority is opt-in and fail-closed: every write or lifecycle capability must be enabled both in the target registry and, for Docker mutations, in the local Docker proxy.

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

The MCP tool receives `verifier_id` plus SQL text. Both control plane and proxy remain typed; the proxy computes SHA-256 and rejects anything that does not exactly match the approved verifier. It runs fixed `psql` arguments with `default_transaction_read_only=on`, explicit `BEGIN TRANSACTION READ ONLY` and bounded timeouts. The caller cannot select container, DB credentials, exec user, environment or arbitrary argv.

This capability is **readback only**. Applying a migration requires a different capability and a separate approval/review.

## Service actions

`service_action` is additionally constrained by normal operating-system permissions. Listing an action in the target registry does not grant sudo or bypass systemd/Polkit.

For a VPS that needs service mutations, grant the agent OS identity only the precise units/actions required by that host. Do not add the agent to broad privileged groups.

## Recommended profiles

- Observation target: `read-only` or `prod-read-mostly`.
- Operator target: Agent Mesh + isolated execution broker + explicit per-capability allowlists.
- Keep a separate read-only target when production observation should remain independent of mutation authority.

## Cross-VPS onboarding

Each VPS should have its own device identity, registry target, workspace, Docker proxy allowlists and OS-level permissions. Do not copy device credentials or operator secrets between VPSs.
