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
- `allowedDockerActions`: any of `start`, `stop`, `restart`.
- `allowedServices`: systemd units visible to service tools.
- `allowedServiceActions`: any of `start`, `stop`, `restart`, `reload`.

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
  "allowedDockerActions": ["restart"],
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
ALLOWED_DOCKER_ACTIONS=restart
```

The target registry can only reduce this authority further.

`docker_exec` does not accept shell text, environment overrides, user overrides, privileged mode, working-directory overrides, mounts or arbitrary Docker API requests. It accepts a container, one program name and an argv array. Output is bounded and redacted before returning to the MCP client.

## Service actions

`service_action` is additionally constrained by normal operating-system permissions. Listing an action in the target registry does not grant sudo or bypass systemd/Polkit.

For a VPS that needs service mutations, grant the agent OS identity only the precise units/actions required by that host. Do not add the agent to broad privileged groups.

## Recommended profiles

- Observation target: `read-only` or `prod-read-mostly`.
- Operator target: Agent Mesh + isolated execution broker + explicit per-capability allowlists.
- Keep a separate read-only target when production observation should remain independent of mutation authority.

## Cross-VPS onboarding

Each VPS should have its own device identity, registry target, workspace, Docker proxy allowlists and OS-level permissions. Do not copy device credentials or operator secrets between VPSs.
