# ADR-0002 — Agent Mesh as the primary device transport

Status: Accepted for implementation
Date: 2026-09-20
Baseline: main@84ba839721f0495a9d9418cde949b00aa1a47fc4

## Context

Remote Ops MCP V1.1 proved the control-plane foundations: OAuth authorization code + PKCE + DCR, persistent sessions, immediate revocation, admin console, audit, bounded read-only tools, target-level enable/disable, secret-path denial, output redaction, and real read-only SSH execution against wandora-prod.

The long-term product goal is not "one MCP server SSHing into every VPS". The intended model is a central Wandora control plane with a lightweight device agent on every managed VPS. Each agent establishes an outbound authenticated channel to the control plane, so customer machines do not need to expose a new inbound management endpoint.

## Decision

Remote Ops MCP V2 adopts **Agent Mesh** as the preferred transport.

Target topology:

```text
ChatGPT / MCP client
        |
        v
https://mcp.wandora.com.br/mcp
        |
        v
Remote Ops Control Plane
        |
        | outbound device session / multiplexed requests
        v
Wandora Ops Agent
        |
        v
bounded local read-only operations
```

SSH remains supported as a compatibility, bootstrap and break-glass transport. It is not the default onboarding path for new devices.

## Device lifecycle

1. An administrator creates a one-time pairing credential for a device.
2. The agent starts locally and connects outbound to the control plane.
3. The pairing credential is consumed once and expires.
4. The control plane issues a device identity and persistent rotatable device credential.
5. The agent reconnects using its device identity.
6. The control plane maintains online/offline/last-seen state from heartbeats.
7. Revocation invalidates the device credential and active session immediately.
8. Re-pairing requires a new administrator-authorized pairing credential.

## Security boundaries

- No arbitrary shell tool.
- No implicit sudo.
- No Docker-group membership as an onboarding requirement.
- Each device has an independent credential and capability profile.
- Pairing credentials are short-lived, single-use and stored hashed server-side.
- Persistent device credentials are never logged.
- The agent accepts only typed, allowlisted operations with bounded arguments and output.
- Request IDs are unique and replay-protected.
- Every dispatch and result is audited centrally.
- Agent execution defaults to read-only.
- Device revocation is checked centrally before every dispatch.
- A disconnected or revoked agent fails closed.
- Cloudflare/edge exposure terminates at the control plane; agents initiate outbound connections.
- SSH host access may remain available for bootstrap/break-glass but is not required by the mesh protocol.

## Transport

V2 will introduce a transport named `agent` alongside `ssh` and `mock`.

The first implementation should use a long-lived HTTPS-compatible channel that works cleanly behind Cloudflare and common outbound firewalls. WebSocket over TLS is the preferred initial candidate because it supports bidirectional request/response, heartbeat and reconnection while remaining operationally simple. The implementation must keep the protocol independent enough to permit a future HTTP/2 or WebTransport transport without changing MCP tool contracts.

## Protocol envelope

Messages use a versioned envelope and never carry shell text.

Example classes:

- `hello`
- `heartbeat`
- `execute_request`
- `execute_result`
- `cancel_request`
- `rotate_credential`
- `server_notice`

An `execute_request` identifies a bounded operation and structured arguments, not a command line.

## Control-plane state

V2 adds durable state for:

- devices
- pairing grants
- device credentials
- active device sessions
- device capabilities
- heartbeat / last-seen
- in-flight requests
- revocation state

The current JSON state store remains suitable only for the first single-instance prototype. Before multi-replica production, device/session state must move to a shared transactional store.

## Compatibility

Existing MCP clients and the 19 read-only tools remain unchanged. Tool dispatch selects the configured target transport.

Existing `ssh` targets continue to work.

## Rollout

1. Build protocol types and state model.
2. Build pairing APIs and admin controls.
3. Build control-plane WebSocket device gateway.
4. Build `wandora-ops-agent`.
5. Add `agent` transport adapter.
6. Pair the existing `wandora-vps-01` as the first real device.
7. Validate reconnect, restart persistence, duplicate-session handling, revoke, replay rejection and bounded operations.
8. Keep SSH configured as fallback during soak.
9. Make Agent Mesh the default target onboarding path after production attestation.

## Explicit non-goals for the first slice

- write/mutation tools
- interactive terminal
- remote desktop
- arbitrary command execution
- multi-region/high-availability mesh
- auto-enrolling devices without administrator pairing
- giving the agent Docker-root authority

## Consequences

The control plane becomes the only public management entry point. Device onboarding becomes substantially easier for VPSs behind NAT/firewalls and for customer infrastructure. The cost is additional protocol, device lifecycle and state-management complexity; therefore rollout is staged and SSH remains available as a proven fallback until Agent Mesh is fully attested.
