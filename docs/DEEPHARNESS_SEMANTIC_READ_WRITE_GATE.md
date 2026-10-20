# DeepHarness Agent Teams via connected Remote-Ops MCP — read AND write

Status 2026-10-19: Draft engineering only; NO-GO for production.
Owner authorized development of reading and writing through the existing ChatGPT
Wandora MCP, plus one synthetic instruction to a verified laboratory Lead when
a scoped lab endpoint is available. This does not authorize production Lead
messages, deployment, target-authority changes or exposing a listener.

## Requested capabilities

- Discover scoped/authorized workspaces and Lead sessions (future adapter).
- Read the exact authorized Lead's Team members and task projection.
- Read bounded, authorized Lead chat messages.
- Send a textual instruction to the exact authorized Lead with durable
  idempotency and audit. No arbitrary execution or system shell.

## Current evidence and gaps

- Target deepharness-read exists on 28server with read-only profile and Docker
  read on exactly two DSH containers. No Docker exec, semantic or write authority.
- DSH Draft PR #4 has an Agent Team read model, not a proven Lead write endpoint.
- Remote-Ops bearer middleware knows oauthClientId and oauthSessionId; this
  PR forwards these verified request fields into MCP ToolCtx (still optional
  and denied by policy unless a trusted grant backend is wired).
- Existing Remote-Ops OAuth uses the mcp:read scope even for older mutation
  tools, and its shared-password login does NOT establish a Keycloak human sub.
  This scope alone must NEVER authorize Lead chat writes.
- Do NOT change DeepHarness Docker/Keycloak or the Cloudflare PKCE exception.

## Code-only policy boundary in this PR

integrations/deepharness/semantic-policy.mjs declares three dependency-injected
operations: readTeam, readChat, sendLeadInstruction. The backing DSH dependencies
are NOT supplied and this PR does NOT register MCP tools.

- Caller identity must be injected from verified OAuth client/session middleware;
  principal, grants and authorization may not originate from MCP tool arguments.
- Each call requires an exact workspace/Lead grant, scoped to the authenticated
  caller and separate actions team.read, chat.read, lead.instruct.
- Reads check current grants before and after awaiting DSH projection access.
- A Lead write requires a bounded textual instruction and UUID idempotency key.
  The DSH backend MUST transactionally recheck the grant/revision at commit and
  enforce deduplication keyed by caller and idempotency UUID. A preflight
  authorization check alone is not a write authorization boundary.
- Response to write includes only a bounded acknowledgement, not message text.
  Do not leak other teams, secrets, raw logs or DSH internal errors.
- Negative tests cover absent/mismatched identity, workspace and action grants,
  revocation during a read, revision changes, invalid messages, and missing
  commit-time authorization attestation.

## Remaining gates (all NOT yet complete)

1. Pin the official DSH 0.2.1-alpha.2 source contract and qualify it on
   the actually installed DSH runtime (source adapter now written, runtime
   qualification **not yet done**): upstream commit
   d743267388641bc76f17c45ce8b4c231aed1d32c;
   packages/api/session-controller/src/index.ts exposes ctx.sessionController
   and @Remote('prompt') / @Remote('projections') / inspect;
   packages/api/session-controller/src/commands.ts handles a user prompt
   with mode 'queue' and durable requestId; AgentTeamService.sendMessage
   requires an actual Team Agent sender and must **not** be used here.
   The draft official-dsh-host-session.mjs adapts those methods, maps
   bounded Team/task/chat fields and calls prompt under a required injected
   withAuthorizedLeadCommit callback. This code is **not** a deployed backend.
   DSH SessionController.prompt acknowledges inbox admission, not model
   completion; its idempotent requestId precheck does not itself prove a
   durable uniqueness constraint under concurrent submissions.
2. Bind the Remote-Ops authenticated session to a separately verified individual
   Keycloak subject and exact per-workspace/per-Lead read/send grants; propagate
   clientId/sessionId into ToolCtx after reviewed changes.
3. Create a dedicated restricted Agent Mesh semantic bridge on 28server to a
   protected local DSH interface with host-side allowlists. Preserve existing
   read-only target; no docker.sock, docker exec, shell, all-workspace grant,
   public listener or inherited operator profile.
4. After the backend is proven, register MCP tools named dsh_read_agent_team,
   dsh_read_lead_chat and dsh_send_lead_instruction. Audit caller, workspace,
   Lead, idempotency, decision and outcome, not raw instruction/token content.
5. Run negative tests for denied, revoked, stale and concurrent grants, duplicate
   writes, restarts and retries, wrong targets and sessions; test against a
   disposable official DSH host. All exceptions fail closed.
6. Separately authorize a GitOps/Portainer rollout. Permit only one synthetic
   explicitly authorized Lead-message canary after all previous gates.

Rollback: revert this Draft PR; no production services are modified.
Current status: read/write semantic contract prepared, NOT connected/live.

## 2026-10-19 Stage 2 — official host binding code only

Source: packages/api/session-controller/src/index.ts, commands.ts, types.ts
and packages/experimental/agent-team/src/types.ts at pinned upstream commit.
The adapter uses official SessionController.projections (the Lead Team
projection), inspect (durable Session events) and prompt (user-message queue).
A Team projection and workspace membership check are additional checks, not
proof of human authorization. Only explicit current grants may authorize.
The actual DSH-side withAuthorizedLeadCommit provider is intentionally
unimplemented: it must serialize revocation and idempotent delivery and
produce a durable receipt. If not supplied, the adapter constructor denies.
Do not fake authorizationCheckedAtCommit; DSH SessionController.prompt does
not provide a transactional PostgreSQL grant check by itself. Acknowledgement
means the DSH inbox accepted text, not the agent executed or completed it.

Tests are synthetic dependency-injected fixtures, not installation or live
chat evidence. The new CI gate runs both policy and official-host tests.

## Stage 3 — end-to-end synthetic composition (2026-10-19)

The new integrations/deepharness/composition.mjs wires the fail-closed
Remote-Ops OAuth/session grant checks to the pinned official DSH
SessionController host adapter. Both independent and composed synthetic unit
tests verify scoped Team/chat reads and one queued Lead instruction.
The fixture substitutes a trusted durable grant transaction; no real DB or
DSH service is invoked. Only an audited PostgreSQL grant/commit provider
with revocation serialization and durable idempotent receipts can qualify
production writes. Even if CI is green, neither OAuth client identity
forwarding nor these unit fixtures prove a human Keycloak subject mapping.
The existing MCP endpoint continues to expose exactly its previous tools:
no new dsh_* tools are registered until the host Agent Mesh bridge, human
identity mapping and explicit write grants are installed and canary-tested.


## 2026-10-19 Stage 5 — preserve full caller identity in DSH retry keys

The OAuth middleware's audit actor contains only the first 12 characters of the
session ID. The official host adapter now also requires the verified full
`clientId` and `sessionId`, and validates that the actor matches that identity.
The trusted commit provider receives both full identifiers, so its durable
idempotency key can be scoped to the actual OAuth client/session tuple.

For DSH's official `SessionController.prompt`, the adapter derives a stable
`requestId` as `mcp_<sha256>` over the actor, full client/session IDs, workspace,
Lead and caller idempotency UUID. This preserves a retry ID for the same scoped
caller while separating identical caller UUIDs across sessions or Leads. The
original UUID remains the idempotency key passed to the trusted commit provider.
This prevents collisions in the DSH prompt dedupe key; it does **not** implement
the missing persistent provider or prove concurrent uniqueness by itself.

Focused isolated Node tests: **11/11 pass**. CI and policy gate for PR head
`feace0e31e4c9a3fefb11861525f493c28704072` were queued at last check. No live
DSH endpoint, registered MCP tool or synthetic message is available yet.


## 2026-10-19 Stage 4 — authorization and lab endpoint reconciliation

The owner explicitly authorized development and one synthetic instruction to
a verified laboratory Lead. This authorization does not authorize production
Lead messages, deployment or privilege expansion.

The current ChatGPT MCP tool registry exposes only the existing
`deepharness-read` Docker-read prepare/apply actions. It exposes no semantic
`dsh_*` operation and no laboratory DSH endpoint. The target remains read-only
with zero semantic capabilities. No synthetic instruction was sent.

DeepHarness PR #4 remains Draft and is based on a non-main branch. Its proposed
read-only MCP connector uses its own OAuth/Keycloak flow; it does not provide a
ready write bridge for the existing Remote-Ops MCP and is not being adopted as
an implicit dependency.

**Decision:** keep production NO-GO and preserve `deepharness-read` unchanged.
Continue only with a separately scoped, private host-to-DSH semantic bridge and
persistent grants/idempotency implementation, then run the authorized synthetic
canary against a disposable lab session after that endpoint is available.
Authorization was received; the missing callable lab capability is the blocker.

## Stage 6 — persistent scoped grant and idempotency gate (2026-10-19)

`integrations/deepharness/persistent-grant-store.mjs` adds a single-active-
instance file-backed grant/receipt store. Grants bind the exact OAuth client,
session, workspace, Lead and action set. The API does not infer a human
Keycloak identity from Remote-Ops OAuth; its principal remains the verified
Remote-Ops client/session tuple. Grant replace/revoke and Lead commits share a
serialized queue, so a revocation cannot interleave after a commit's current
grant check and before prompt admission.

Before calling the DSH prompt, the store durably writes a pending idempotency
record. On acknowledgement it atomically persists a bounded receipt. Retries
use the same DSH `requestId`; the DSH controller checks inbox and durable
Session events for that id, so a retry after an acknowledgement loss is
deduplicated by the official prompt service. The store keeps only a SHA-256
instruction fingerprint, never the instruction text. It writes a private mode
0600 file by fsync + rename, and denies malformed/symlink stores. A failed call
retains its pending intent for a same-key retry; changing the instruction,
scope or grant revision with that key is denied.

The write response labels its identifier `receipt_id`: it is a Remote-Ops
commit receipt, not a DSH event/message identifier. `accepted: true` means only
that the official DSH prompt API acknowledged inbox admission; it does not mean
the Lead completed the work. Results must be read separately from DSH history.

Focused synthetic tests now cover concurrent duplicate calls, changed-payload
conflict, revocation serialization, restart recovery, acknowledgement loss,
private file mode and instruction non-persistence. **36/36 isolated Node tests
pass.** The durable store can be injected into the existing policy/official-host
composition, and the adapter passes only a one-way payload hash to it.

### Remaining activation gaps

- The store is not initialized by the Remote-Ops server bootstrap, has no
  administrator grant-provisioning endpoint/UI, and is not yet part of the
  live MCP tool registry. No caller can grant itself access through MCP.
- The connected Wandora runtime's `deepharness-read` target still has a
  read-only profile, zero semantic capabilities, and zero Docker-exec
  containers/programs. Safe inspect on `deepharness-web-1` confirms the running
  immutable image is `ghcr.io/oaranha/deepharness-mcp@sha256:2483c85cc3fbe6172bf284e67859572b8b6b5dc75bfea11ae160298f7202a62f`, started as
  `/opt/wandora-mcp-verifier/mcp/run-operational.mjs`, on private network
  `deepharness_mcp-private`; this is a DSH MCP host container, not proof that
  the official DSH `SessionController` services are reachable from Remote-Ops.
- The integration tests use in-process fixtures. No database, network bridge,
  actual running DSH host or persistent DSH inbox was exercised. The file store
  assumes exactly one active Remote-Ops writer; it is not safe for active-active
  instances and is not configured in production.
- No `dsh_*` tools are exposed by the current connected Wandora MCP. No message
  was sent. Production and any live target changes remain **NO-GO**.

### Next code gate

Implement the separately scoped host-to-DSH transport and server bootstrap
composition with tests against an isolated official DSH host. Add a private
administrator path to create/revoke exact grants, without turning MCP callers
into grant administrators. Then register only the semantic read/write tools
against that host service, test restart/retry persistence, and prepare the
separate deployment approval package. No deployment or production Lead write
is included in this stage.

## Stage 7 — scope Docker inventory metadata (2026-10-19)

Live read-only reconciliation found that `docker_list` returned the host's full
`docker ps -a` inventory without applying `allowedDockerContainers`. The
`deepharness-read` target status allowlists inspection of two named DSH
containers, while the live inventory response also disclosed a third unrelated
container's name, image, state and port metadata. This did not grant inspect,
exec or write access to that third container, but it exceeded the target's
declared container-list scope.

The MCP tool now returns only inventory rows whose names are explicitly in the
target allowlist; an empty list returns no rows without querying Docker, and
`*` is the only full-inventory grant. A regression test exercises both the
filter and the actual `docker_list` ToolDef against a mock target. This is a
least-privilege fix; it does not change the live target configuration or grant
any DSH semantic capability.

Focused test: `test-docker-list-scope.mjs`, **5/5 GREEN**. TypeScript build:
**GREEN**. `npm run check` passed the build, general end-to-end checks, pairing,
installer, capability baseline, minimal disclosure, target approval and DSH
read approval gates, then stopped at the existing sandbox restriction where
AF_UNIX socket creation fails with `listen EPERM` in the execution-broker test.
No privilege escalation was used. CI remains the full-suite gate.

Current authorization boundary remains unchanged: the installed DSH private
MCP handler evidenced in PR #4 accepts mTLS plus its own OAuth bearer and only
registers `dsh_read_agent_team`. It is not yet a callable bridge from the
existing Wandora OAuth session, and no `dsh_*` tools are registered here.
Next implementation must add a dedicated fixed semantic Agent Mesh operation
and a matching DSH private service interface, without shell or a second OAuth
application; production remains **NO-GO**.

## Stage 8 — fixed private semantic bridge and Remote-Ops adapter (2026-10-19)

DeepHarness PR #17 adds an opt-in `/wandora/dsh-bridge/v1` route on the
existing DSH private mTLS listener, stacked on Draft PR #13. It uses the
official WorkspaceRegistry and SessionController projection, history-page and
prompt APIs. The handler pins one exact Remote-Ops client certificate
fingerprint, accepts only the five semantic operations, limits request and
response sizes, and audits operation/outcome without content or identifiers.
The existing OAuth MCP route remains read-only. The endpoint is disabled by
default; no client certificate, runtime setting, grant or live session was
configured. [source: https://github.com/OARANHA/deepharness/pull/17; added: 2026-10-19]

The Remote-Ops branch now has a fixed mTLS requester for the private DNS
service, a strict semantic client and a backend adapter that composes with the
existing persistent grant/idempotency store. It removes OAuth identity claims
from the DSH request, rechecks the Lead before commit, derives a stable UUID
request ID, pins the DSH server certificate, and rejects mismatched or oversized
replies. Tests cover all five fixed operations, pin mismatch, exact path/host,
grant-backed reads and writes, and commit revalidation. These files are not yet
used by server bootstrap or registered in the MCP tool catalog, and the private
service is not reachable from the running Remote-Ops process in verified
evidence. [source: https://github.com/OARANHA/Remote-Ops-MCP/pull/71; added: 2026-10-19]

The first DSH PR #17 bootstrap CI workflow passed, while its Stage D
PostgreSQL workflow on head `173144e7eadc9bb61b3c1917e774d7e1045eac0d` failed
because its disposable composition fixture omitted SessionController. The
fixture correction passed the PostgreSQL primary job on head
`1fff568d27670314d009ebe16a509199bdf7a0c5`, but the candidate job then exposed
the upgrade verifier's hard-coded lab.5 version. Bootstrap CI passed; overall
Stage D remains RED until the exact packed-version verification change passes.
Remote-Ops CI #258 and semantic gate #22 passed for head
`944792f987dae971c2a12998bda8cdb399e6661a`.

## Stage 9 — opt-in Remote-Ops MCP tools (2026-10-19)

Remote-Ops registers the five semantic tools `dsh_list_teams`,
`dsh_get_team_status`, `dsh_list_tasks`, `dsh_read_lead_chat`, and
`dsh_send_lead_instruction` only when `DSH_SEMANTIC_ENABLED=1`. Startup rejects
`AUTH_MODE=noauth`, requires fixed client certificate/key/CA files, and pins
the exact DSH server fingerprint. `dsh_list_teams` discovers only current
`team.read` grants for the verified OAuth client/session and requested
workspace, then reauthorizes each Lead. Status/tasks, chat and instructions
use action-separated grants. `mcp:read` alone authorizes no DSH operation.
The OAuth client/session tuple is an application caller identity, not proof of
an individual Keycloak human subject.

The persistent grant store starts empty and assumes exactly one active
Remote-Ops process. There is no reviewed grant-administration command or
provisioned grant file. The tools exist in the Draft branch but are absent from
the live Wandora connection; no grant or Lead message has been created. Local
verification on the current code: TypeScript build GREEN, semantic tests
50/50 GREEN, Docker scope 5/5 GREEN, candidate contract and compose wiring
GREEN. The current head CI #259 and semantic gate #23 passed. Production
remains **NO-GO**.

## Stage 10 — real local mTLS transport test (2026-10-19)

`private-bridge-client.tls.integration.test.mjs` exercises the Remote-Ops
client over a real local HTTPS socket with mutual TLS. It creates a throwaway
CA, server certificate and client certificate in a temporary directory,
requires the client certificate at the server, verifies the fixed DSH hostname
and route, posts a bounded semantic instruction, and proves that a wrong
server-certificate pin is rejected. The production client still fixes its
hostname, port and route; only the injected test transport routes to an
ephemeral loopback port.

This validates the transport and pin checks across a real TLS handshake. It
does not exercise the DSH HTTP handler, actual SessionController, durable
session history, Lead response, or production private network. The new test
passed locally with the existing semantic suite: **50/50**. Production remains
**NO-GO**.

### Remaining activation gates

- Reconcile the DSH dependency stack: PRs #8–#13 are all open Draft and
  unmerged; PR #17 depends on #13. Their associated CI runs and PR #17's
  bootstrap #474 and Stage D #18 passed, but this does not authorize merge.
- Add a separately reviewed provisioning/revocation path for exact
  client/session/workspace/Lead/action grants. It must not allow a caller to
  grant itself access.
- On a disposable DSH host, admit an instruction through the actual
  SessionController, restart/reopen the Session, and verify the durable user
  message plus later Lead response.
- Verify the fixed private DNS route is reachable only through the intended
  internal network and prepare certificate/runtime enablement for a lab-only
  canary. No production route, credential, grant, or target was changed.

Production remains **NO-GO**. No message has been sent to a production or
laboratory Lead from this implementation.

## Cross-VPS transport blocker — verified 2026-10-19

Live read-only host status identifies the connected Wandora target as
`wandora-vps-01` and the DeepHarness target as `28server`. The Remote-Ops
mTLS client is fixed to `deepharness-mcp-backend:3443`; this is a Docker-local
alias on the DeepHarness internal network, **not a proven route from the
Wandora VPS**. The inspected DSH container publishes no Docker ports.
Registering `dsh_*` on Remote-Ops without a proven cross-VPS private route
would expose unusable tool names, not real DSH access.

**Mandatory deployment gate:** a separately approved restricted inter-VPS
private tunnel/overlay/relay with end-to-end pinned mTLS to the DSH semantic
handler. Verify DNS, routing, TLS peer fingerprint, exact operation policy,
revocation, idempotency and negative cross-workspace access in a disposable
environment first. The private link must not expose the DSH port publicly or
broaden the `deepharness-read` Docker target. Neither OAuth reuse nor a
GREEN PR authorizes production networking/deployment.

No tunnel, DNS, endpoint or permission was installed in this check.


## Stage 11 — Agent Mesh local semantic transport review (2026-10-19; Draft, not activated)

**Verified topology and identity.** Existing ChatGPT → Remote-Ops OAuth
connection runs on `wandora-vps-01`; Agent Mesh's outbound authenticated WSS
already reaches `28server` (host `wandora-ops-agent.service` active). The
`deepharness-read` target is **read-only** and reports
`allowedSemanticCapabilities=[]`. Live `deepharness-web-1` runs with
`HostConfig.NetworkMode=deepharness_mcp-private` and
`PortBindings={}`; the semantic handler, when enabled in a future reviewed
image, would bind to the internal `deepharness-mcp-backend:3443` Docker alias.
**Important:** Agent Mesh connects to the **host** but provides no demonstrated
access to this Docker-private TLS endpoint. No host-network, public ingress,
generic Docker exec, or direct access can be inferred.

**New inert code:** `integrations/deepharness/agent-mesh-contract.mjs` and
`agent-mesh-contract.test.mjs` define a strict two-way envelope for the *five*
reviewed operations (listTeams, getTeamStatus, listTasks, readLeadChat,
sendLeadInstruction). Unknown keys, URLs, ports, hostnames, target choices,
credentials, actor/grant assertions, shell commands, invalid IDs, oversized
messages, bad request IDs and invalid histories fail closed. The wrapper carries
only operation-specific workspace/Lead identifiers and constrained text when
required. It has no outbound networking, certificates, listener, agent command
registration, runtime bootstrap wiring or grant provisioning. The existing
`DSH_SEMANTIC_ENABLED` default-off runtime stays unchanged.

**Separate implementation and approval gates, in order:**

1. **Local reachability design:** qualify a dedicated fixed endpoint accessed
   by the *28server agent process* without exposing the DSH Docker listener to
   the public internet. A candidate is an operator-managed restricted
   AF_UNIX-to-private-network relay associated only with the reviewed DSH
   container network and handler path. This is an architecture candidate, not a
   deployed or selected implementation. Validate its Linux permissions,
   compartment boundaries, process lifetime, certificate trust and negative
   reachability before choosing it. Do not rely on an unverified container IP,
   broad host-network access or an unpinned TCP forward.
2. **Host enforcement:** only a named `deepharness.semantic` Agent Mesh
   operation may use the reviewed local path. Add independent allowlisting and
   opt-in on the **28server** agent; the control plane's OAuth grant must not
   become a self-issued host capability. Never provide arbitrary argv,
   filesystem access, host/URL override, certificate bytes, or Docker authority
   in the MCP request. Preserve fixed mTLS server name, certificate/CA pinning
   and exactly scoped handler operations.
3. **Control-plane authorization:** after verifying the OAuth client/session
   tuple, persist and recheck exact workspace/Lead/action grants and revocation
   at dispatch/commit using the existing restricted store. Transport admission
   and `{accepted:true}` are not proof that a model processed the instruction.
   No added OAuth application or inherited `deepharness-read` privileges.
4. **Disposable gates:** test the Agent Mesh WSS-hop using mocked/throwaway
   identities, fail-closed host operation handling, TLS peer mismatch,
   unavailable local relay, denied/revoked/mismatched grants, bounded response,
   idempotent retry, *official* DSH session durable replay and independent
   answer readback. The successful DSH rc.2 Bootstrap #492 / Stage D #36
   proves a cold **synthetic** JSONL/SessionQuery read; it does not prove Lead
   response or live cross-VPS traffic.
5. **Promotion gate:** reviewed source/artifact provenance, explicit operator
   configuration, short-lived per-service credentials, rollback and **separate
   user approval** for any Portainer/agent/relay activation. Production
   `deepharness-read` stays untouched throughout Draft development.

**Do not confuse code prepared with live functionality.** A prior attempt to
change the fixed Remote-Ops mTLS client to accept an operator-specified private
IP was blocked by the platform. That specific change was **not applied** and
must not be recreated through another write route. This Stage 11 design uses
existing Agent Mesh as a prospective control-plane hop, not a workaround
claimed to be installed. No live Lead messages or semantic tool calls occurred.

## Stage 12 — disabled 28server Agent Mesh receiver (Draft, 2026-10-19)

`src/agent/deepharness.ts` now implements a *host-side* receiver for the
exact Agent Mesh operation `deepharness.semantic`; `src/agent/operations.ts`
dispatches only that named operation to the receiver. It remains **off by
default** and fails closed unless the operator supplies all three trusted
host-side values: `DSH_AGENT_MESH_ENABLED=1`,
`DSH_AGENT_MESH_WORKSPACE_ID` and `DSH_AGENT_MESH_LEAD_SESSION_ID`.
Values cannot be set by the MCP caller; the receiver requires the exact
workspace/Lead, validates five operations and rejects extra request fields.
A `listTeams` reply is filtered to the host-authorized Lead.

The only proposed local transport is the fixed Unix-domain socket
`/run/wandora/deepharness-semantic/bridge.sock`. The receiver refuses a
missing/non-socket/symlink endpoint, untrusted owner, and world-accessible
socket/directory. Calls use the fixed `/wandora/dsh-bridge/v1` route and
bounded HTTP JSON exchange. No network listener, Docker access, TCP
forwarder, relay, filesystem writer, certificate/secret, grant administrator
or runtime setting is provisioned. Requests to the socket **do not themselves
establish mTLS**; the separately approved relay must authenticate the local
caller and establish certificate-pinned mTLS to the private DSH handler.
Existing Remote-Ops mTLS private-client code remains unchanged.

`test-deepharness-agent-mesh-runtime.mjs` exercises default refusal,
wrong workspace/Lead, invalid and oversized content, absent socket,
strict response metadata and a throwaway owner-controlled AF_UNIX HTTP
server. The main CI runs it after the TypeScript build; failures must be
fixed before further integration. This tests the *local receiver*, **not**
Agent Mesh end-to-end dispatch, a verified mTLS relay, a durable actual Lead
instruction or a production endpoint. The connected Remote-Ops
`DSH_SEMANTIC_ENABLED` tool bootstrap still selects its existing
unreachable cross-VPS hostname, so additional reviewed control-plane
transport composition is required before any canary.

**NO-GO:** no source merge, relay install, agent restart, grants change,
MCP tool activation, Docker network change or Lead message is authorized
by this code-only Draft stage.


## Stage 13 — private Unix relay handler (Draft only; 2026-10-19)

Following **GREEN** CI #270 and semantic gate #34 at PR #71 commit
`9a19e19629fd34018f5dcb13266c2a418754888e`, a new **inert**
`integrations/deepharness/agent-mesh-unix-relay.mjs` module implements
a constrained HTTP-over-Unix request handler. It is **not** a running
daemon, a socket creator, an active listener, a Docker network change,
an Agent Mesh grant, an OAuth application or production configuration.

The handler accepts only the exact path `/wandora/dsh-bridge/v1`, POST,
bounded JSON with `Content-Length`, the five allowed DSH semantic
operations, and the operator-configured workspace and Lead. It rejects
extra arguments, requested destinations, grants, identities and arbitrary
commands. `listTeams` results are filtered again by the configured
Lead, and the response size is bounded. Errors are generic and must
not disclose an upstream TLS failure or instruction content.

The separate factory `createDshAgentMeshUnixRelayOverMtls` composes
the **existing**, unchanged fixed-address, CA-trusted, certificate-pinned
mTLS requester. It does not construct or activate a network listener;
the necessary dedicated relay runtime/container and reviewed operator
settings have not been built or deployed. No alternative TCP/IP routing
change was made to the previously blocked client code.

`agent-mesh-unix-relay.test.mjs` covers requests sent over a *real
ephemeral Unix socket* against a synthetic DSH backend, including
wrong Lead/workspace, invalid inputs, non-JSON responses, excess
payloads and response leakage. The main CI now also tests host receiver
→ this relay over a throwaway Unix socket with an in-memory DSH stub.
These gates **do not** validate the container-bound mTLS hop,
true identity mapping, deployed grant provisioning, actual SessionController
prompt execution or a real Lead answer.

**Deployment and integration gates still outstanding:** create a
reviewed non-root/least-privileged sidecar attached only to the DSH
private Docker network, choose and enforce socket owner/group/mode
consistent with the `ops-mcp` agent, bind-mount only the private
socket directory, supply pinned mTLS material via separately approved
secrets, verify listener identity, validate real mTLS and exact
revocation/idempotency on a disposable DSH Lead, and modify the
control-plane transport only behind an independent semantic target
grant. Preserve existing `deepharness-read` target unchanged.
A request accepted by an inbox is not proof of model completion.

**Current CI checkpoint:** Remote-Ops CI #273 and semantic policy #37
were `in_progress` on PR #71 head
`33361fb8079a8e5655bd7b26a3eeed765e147667` at time of inspection.
Do not infer GREEN from test code or parent-commit results.
Production stays **NO-GO**.


## Stage 14 — opt-in private Unix relay listener and runtime (Draft-only, 2026-10-19)

After CI #278 and semantic policy #42 completed SUCCESS on PR #71 commit
`fe69739f7543c0dacc7b2cbd2385df3ffad85035`, add separate inert,
testable runtime modules. No deployment or enabled services.

- `integrations/deepharness/agent-mesh-unix-listener.mjs` exposes
  `startDshUnixRelayListener` only to an explicitly calling owner.
  It requires an owner-only (0700), pre-provisioned, non-symlink
  directory, a non-root process UID, and an unused fixed Unix socket path.
  It neither creates a directory nor unlinks an existing endpoint.
  On success the socket is 0600, owner-verified, inode-checked, with
  bounded HTTP connection/request limits; shutdown avoids unlinking a
  path replaced by another inode. No TCP listener is constructed.
  The fixed production path remains
  `/run/wandora/deepharness-semantic/bridge.sock`.
- `integrations/deepharness/agent-mesh-unix-relay-run.mjs` is a distinct
  script requiring `DSH_UNIX_RELAY_ENABLED=1` and exact operator-owned
  `DSH_UNIX_RELAY_WORKSPACE_ID`,
  `DSH_UNIX_RELAY_LEAD_SESSION_ID`, and
  `DSH_BRIDGE_SERVER_FP_SHA256`. It reads exactly three configured-in-image
  secret paths (`/run/secrets/dsh-bridge-{ca,client-cert,client-key}.pem`)
  and constructs the existing hostname/SNI/certificate-pinned mTLS client.
  Nothing in the MCP request can change identity, target, socket path or
  certificate. Importing it does nothing; no environment variables are set
  in any production runtime by this PR.
- `agent-mesh-unix-listener.test.mjs` verifies denial by default,
  nonroot and directory ownership checks, pre-existing-file refusal,
  actual Unix socket and close. `agent-mesh-unix-relay-run.test.mjs`
  checks no I/O without opt-in, fixed TLS material paths and no bind on
  missing secrets. Both execute entirely in disposable CI.

**Critical deployment compatibility gate (unresolved):** the 28server
host receiver currently accepts sockets owned by root or its own
`ops-mcp` UID. The draft listener requires owner-only directory and
socket mode 0600. Therefore an eventual relay container must run under
a **reviewed matching UID**, on a private mount accessible by the host
agent, without giving the agent access to the container's private
mTLS key files. Do not silently assume Node image's UID 1000 matches
the host service. Verify numeric UID and mount/namespace ownership in
an isolated candidate, rather than changing the target's allowlist,
using privileged Docker, or relaxing socket mode.

**Not yet qualified:** a sidecar image or Compose profile, approved
socket directory provisioning, UID mapping, secrets provisioning,
a real mTLS request across the DSH private Docker network, agent WSS
dispatch using a persisted specific grant, revocation/receipt replay,
and any actual Lead reply. No existing Portainer stack, agent service,
OAuth client or public listener was touched. Merging or deploying
requires separate authorization.


## Stage 15 — distinct relay and Agent Mesh identities (Draft review profile)

Stage 14's same-UID/0600-socket idea was rejected during threat review:
sharing the host `ops-mcp` UID with the container relay could make its
operator-owned host TLS files readable by an unprivileged agent on the same
host. **Stage 15 supersedes Stage 14's UID/mode admission policy.**

The proposed isolation boundary is now:

- The relay runs under its own **distinct nonroot numeric UID**, not root,
  not the host `ops-mcp` UID. The host Agent Mesh service stays `ops-mcp`,
  not in the Docker group and without access to the relay's credential
  directories. No UID number is assumed from the host install script.
- An operator must separately pre-provision
  `/run/wandora/deepharness-semantic` owned by
  `<relay-uid>:<ops-mcp-gid>` with setgid directory mode **02710**:
  the relay owner can create the socket; the agent group can traverse the
  known directory but cannot list/create files there; all others denied.
  The relay listens only on `bridge.sock` owned by the relay UID and
  socket group GID with mode **0660**. Both directories and sockets are
  lstat/inode-verified, with no pre-existing file replacement.
- The relay initializer now requires `DSH_UNIX_RELAY_SOCKET_GID` to match
  the exact numeric `ops-mcp` group ID. The **28server** host receiver,
  when enabled, requires an independently operator-configured
  `DSH_AGENT_MESH_RELAY_UID` and `DSH_AGENT_MESH_SOCKET_GID`.
  It checks that the process itself belongs to the specified group and
  that the owner is distinct, then checks strict socket and directory
  owner/group/modes. Client MCP request parameters cannot supply those
  values. Calls fail closed if the pair is missing or mismatched.
- The relay's TLS CA/client certificate/private key must be available **only
  inside the dedicated container**, through individual read-only mounts
  from protected operator-owned paths. The host agent must not be able to
  traverse the secrets' parent directories, read any source key file or
  inspect Docker. This is a mandatory host prerequisite, not automatically
  guaranteed by Docker bind-mounts.
- `integrations/deepharness/Dockerfile.agent-mesh-relay.review` defines a
  small Node 22 candidate image containing only four relay modules. The
  builder must explicitly supply a **reviewed digest-pinned** Node base
  image; there is no default image.
- `integrations/deepharness/agent-mesh-relay.compose.review.yml` is a
  **separate**, non-active `dsh-relay-review` profile. It requires an
  immutable candidate image and exact operator UID/GID, explicitly
  `restart: no`, `read_only: true`, `cap_drop: [ALL]`, no Docker
  socket, no privileged mode, no ports and **only** the existing external
  `deepharness_mcp-private` network. By default the relay remains off
  even if this profile is selected. It mounts only the known Unix socket
  directory and three individually named TLS files. The main Portainer
  stack is **unchanged**. CI uses synthetic inactive environment values
  to run Compose syntax validation only; the syntax gate cannot attest
  actual UID compatibility, TLS/certificate material, or runtime behavior.

**Operational qualification required, still NO-GO:**
(1) verify real numeric `ops-mcp` UID/GID from an authorized host
inspection (systemd unit source reading is denied by the current
`deepharness-read` allowlist; do not bypass it);
(2) review a separate relay UID/GID, inherited socket group, secret path
ownership/traversal and host SELinux/AppArmor restrictions;
(3) build/verify the digest-pinned sidecar candidate, validate 28server
container-network DNS and mTLS with deliberately provisioned ephemeral
certificates in an isolated environment;
(4) only then adapt the control-plane semantic client to Agent Mesh under
exact grants and stable request idempotency;
(5) independently prove official DSH session persistence and a Lead
reply on a disposable Team;
(6) obtain explicit production/change authorization for merge,
certificate provisioning, mount, agent restart or deployment. Neither
a passing Docker Compose syntax check nor a synthetic `accepted:true`
receipt is a live DeepHarness integration.


## Stage 16 — disposable Unix-to-mTLS chain gate (Draft only; 2026-10-19)

The Stage 15 baseline was verified SUCCESS: Remote-Ops CI #293 and
Semantic Policy #57 on PR #71 head
`c3eda5535fa8faff11b47e067ce42949d0ba342a`. The next security
gate must demonstrate that the **same** synthetic request can traverse
the already reviewed Agent Mesh host receiver, a real Unix HTTP socket,
the scoped relay handler, and an actual mutual-TLS HTTPS session,
rather than relying only on independent mocks.

`test-deepharness-agent-mesh-mtls-chain.mjs` is the standalone,
CI-only Stage 16 gate. It creates a one-day disposable CA, server SAN
certificate and client-auth certificate locally; starts one HTTPS
listener on ephemeral **loopback only**, one Unix socket in an
ephemeral private test directory, and uses the *unchanged* production
`createDshMtlsRequester` with its fixed DSH hostname, SNI, fixed
handler route and certificate fingerprint. A `httpsModule` substitution
redirects only this test's network socket to loopback while **asserting**
the fixed hostname/port/path/SNI; it is not a runtime parameter, a DNS
or production IP change.

The CI test routes a scoped synthetic `listTeams` call and a
`sendLeadInstruction` with idempotency ID through the host receiver
and the relay. It checks filtering of another Lead, rejects a
different Lead *before* HTTPS, and rejects a wrong TLS certificate pin.
The synthetic HTTPS responder reports `accepted:true` only; this does
**not** prove a model actually processed an instruction. Unix socket
owner/group and mode metadata in this test are deliberately **mocked**
because the CI runner cannot impersonate the host agent and relay
identities; the actual Unix and TLS I/O remain real.

This test executes after `npm run build`, does not use the live
DSH service, requires no remote credentials and does not install or
start a container on either VPS. A GREEN CI would mean only that
this **disposable transport test** passed. For a real integration,
the separately approved candidate must still prove numeric host
UID/GID, group-only socket access, dedicated sidecar image and private
Docker DNS, real cert provisioning, server trust, OAuth/grant revocation,
idempotency, official DSH services and Lead response readback.
**PR #71 and DSH PR #17 remain Draft; no production activation.**


## Stage 17 — dedicated control-plane Agent Mesh semantic lab path (Draft only; 2026-10-19)

The **Stage 16 CI #296 and Semantic Policy #60** were independently
verified `completed/success` at PR #71 commit
`bb8bc5664c9d7b07d42194dfd469d182c204aae2`. This validated only
the *disposable synthetic* HTTP-over-Unix + pinned mutual TLS chain.

**Control-plane gap addressed in code:** the existing DSH tool bootstrap
still attempted direct HTTPS to Docker-only
`deepharness-mcp-backend:3443` from `wandora-vps-01`. The already-paired
outbound Agent Mesh WSS hop is the appropriate control-plane transport
when the DSH service runs on `28server`. The new module
`integrations/deepharness/agent-mesh-semantic-client.mjs` wraps the
existing fixed five-operation private bridge API with **exactly one**
`deepharness.semantic` Agent Mesh envelope. It does not alter
`private-bridge-client.mjs`, its pinned host/SNI, or production DNS.

**Independent target identity, NOT the current read-only target:** only
a trusted Target Registry record with `id=deepharness-semantic-lab`,
`transport=agent`, `environment=development`,
`capabilityProfile=semantic-operator`, `enabled=true`, one
`allowedSemanticCapabilities=["deepharness.semantic"]`, a valid
`deviceId`, and **no unrelated paths, Docker, service, process or
admin capabilities** is accepted. `deepharness-read` stays unchanged.
No dynamic target was created or authorized by this PR.

`integrations/deepharness/composition.mjs` reuses the exact existing
OAuth client/session and `grantStore` policy via
`composeDeepharnessReadWriteOverAgentMesh`. The existing five `dsh_*`
tool definitions remain behind `DSH_SEMANTIC_ENABLED=1`; the new
explicit selection requires `AUTH_MODE=oauth`,
`DSH_SEMANTIC_TRANSPORT=agent-mesh-lab` and
`DSH_SEMANTIC_AGENT_TARGET_ID=deepharness-semantic-lab`. Without all
of these, no Agent Mesh tools are enabled. The target is loaded from
the registry on the **server**, never supplied by the ChatGPT caller.
Its exact ID, device binding, enabled flag, capability and lab environment
are **rechecked on every dispatch**, so an operator-disabled or replaced
lab target cannot continue accepting requests from a cached session.
The legacy mTLS mode remains separately available as before; its
certificate bytes never enter the Agent Mesh envelope.

`agent-mesh-semantic-client.test.mjs` tests exact target allowlisting,
bounded five-operation dispatch, absence of OAuth claims from the
envelope, denial of Docker/host capabilities, rejected agent errors,
truncated results and malformed JSON. The synthetic integration
`agent-mesh-semantic-policy.integration.test.mjs` composes the real
persistent grant store with Agent Mesh transport, proving a granted
read, chat, one idempotent synthetic instruction, duplicate delivery
receipt, revocation and denial of a forged OAuth session without any
backend call. This is still **not a real Agent Mesh device call** and
does not confirm that the target has been provisioned in live state.

**Critical production NO-GO:** The installed `28server` agent and
DeepHarness container remain unchanged. The sidecar mTLS listener is
not installed or running; real host UID/GID and private socket
access have not been established. No operator target, Lab Lead grant,
TLS secrets, service restart, Portainer change, merge or Lead message
was performed. Even after a GREEN CI, the next required proof is a
separately authorized, isolated disposable canary with reviewed
artifacts and explicitly scoped grants, followed by independent DSH
reply readback. Never call an inbox `accepted:true` receipt a Lead
completion or broaden `deepharness-read`.


## Stage 18 — lab target provisioning with live socket readiness gate (2026-10-19; Draft only)

PR #71 Stage 17 was independently verified **CI #307 and Semantic
Policy #71 SUCCESS** at commit
`aebe60e0eb66017d524825c412ffef4df3a071df`.
No production deployment has occurred.

**Newly closed readiness gap:** The connected `target_agent_prepare`
tool had no preset capable of creating the special
`deepharness-semantic-lab` Agent Mesh target, even though the new DSH
tool loader already required it. The existing
`src/config/capability-baseline.ts`,
`src/config/target-approvals.ts` and `src/tools/index.ts` now include
**only one** new preset `deepharness-semantic-lab`:

- It requires **exact** `target_id=deepharness-semantic-lab`, environment
  `development`, `AUTH_MODE=oauth` and a strong configured auth secret.
- It derives `capabilityProfile=semantic-operator` and one capability
  `allowedSemanticCapabilities=["deepharness.semantic"]` with all
  generic filesystem, process, Docker, Git, service and admin
  permissions EMPTY. It never inherits `operator-workspace`.
- The selected **already-paired, live Agent Mesh device** must actually
  advertise `deepharness.semantic` both on `prepare` and immediately
  before `apply`. A stale/missing capability refuses the approval. All
  normal actor-bound expiring `APPROVE adm_...` confirmations still
  apply; no target is created by a `prepare`.
- The `28server` agent's new
  `src/agent/deepharness-advertisement.ts` exports a read-only
  capability probe. The agent advertises `deepharness.semantic`
  only when its operator-side enable flag, workspace and Lead scope,
  distinct relay UID, required group membership, and **existing**
  AF_UNIX directory/socket owner/group/type/modes all match
  the Stage 15 policy. It does not create/start any socket, listener,
  container, or Keycloak application. It remains inert in the currently
  installed agent until a separately authorized agent update.
- The DSH MCP tool loader also rechecks the durable *runtime target
  disable overlay* (`effectiveTargetEnabled`), not merely the target's
  static `enabled` bit, on **each** semantic dispatch. This must deny
  a previously active client/session when an operator disables its
  dedicated lab target.
- New isolated CI tests `test-deepharness-agent-advertisement.mjs`
  and `test-deepharness-semantic-target-approval.mjs` exercise the
  host readiness probe, wrong UID/GID/mode, absent socket, approval
  prepare/apply without agent announcement, actor mismatch,
  an expiring-style human confirmation, no target creation before
  approval, absence of generic authorities, runtime target disable
  and the preservation of existing static targets.

**NO-GO remains unchanged.** No real `deepharness.semantic`
capability has been advertised by the deployed `28server` agent;
no `target_agent_prepare/apply` has been called in production,
and `deepharness-read` stays production read-only.
Actual host UID/GID, private sidecar socket and mTLS provisioning,
Agent Mesh service installation, exact scoped DSH grant and an
authorized disposable Lead canary require separate operational
evidence and explicit owner approval. A GREEN for these offline tests
will not mean ChatGPT can instruct a live Lead yet.


## Stage 19 — approved preparation only; runtime activation remains NO-GO

On 2026-10-20 the owner approved **preparation of a controlled
installation plan with rollback**, explicitly reserving real runtime
activation, target/grant changes and Lead instructions for later
approvals. This is not permission to create an operator account, socket,
mount secrets, install/launch a container, restart Agent Mesh or alter
the running Portainer stack.

Operator-verified `28server`: host `ops-mcp` UID=999 GID=987;
DSH Web and MCP proxy users=1000:1000; both on internal
`deepharness_mcp-private`; Web publishes the fixed private DNS alias
`deepharness-mcp-backend`. Relay directory and socket are absent.
None of this verifies actual TCP 3443 mTLS acceptability or Agent Mesh
WSS status; prior calls to the read-only target timed out.

The standalone operator **dry-run** preflight
`integrations/deepharness/relay-host-preflight.mjs` checks only fixed
identity, network, container and Unix metadata via read-only commands,
never reads key/secret content, and never modifies the host. Associated
tests are `relay-host-preflight.test.mjs` and are included in the
existing `integrations/deepharness/*.test.mjs` CI glob.
An unselected dedicated relay UID produces `NO_GO` as expected;
`PREPARE_ONLY` is explicitly *not* deploy authority.

**Canonical operations plan:** see
[`docs/DEEPHARNESS_RELAY_CONTROLLED_PREINSTALLATION.md`](DEEPHARNESS_RELAY_CONTROLLED_PREINSTALLATION.md)
for verified vs unknown facts, UID/GID reservations, 02710/0660
permissions, isolated immutable sidecar image, TLS/PKI gate,
Agent Mesh availability, explicit staged approvals, negative
security gates, and per-service rollback. No production change
is part of this Draft commit.


## Gate de integração cruzada com handler real DeepHarness — 2026-10-20

A PR #71 agora exercita o **código real revisado** do backend semântico do
DeepHarness, não apenas um servidor HTTPS que devolve respostas sintéticas.
O workflow de CI `.github/workflows/ci.yml` faz checkout da fonte pública
`OARANHA/deepharness` no SHA **exato e fixado**
`9c1ac05bf9a0a3fa2ef9f95a3248f156c3fa5d15` em
`.ci-dsh-reviewed/`; valida `git rev-parse HEAD` antes do teste e exclui
este checkout do Git e do contexto de build Docker.

O teste `test-deepharness-agent-mesh-mtls-chain.mjs` chama, em ambiente
efêmero CI, os exportados reais `createDshSemanticBridge` e
`createPrivateSemanticHttpHandler` dessa revisão, através dos componentes
reais Wandora **Agent Mesh receiver → socket Unix → relay → HTTPS mTLS
pinned → handler/bridge DeepHarness**. Usa CA e certificados temporários
gerados localmente. Confirma projeção do Lead sintético, admissão de um
prompt somente textual com `requestId` e rejeição do fingerprint TLS
incorreto antes de encaminhar para o backend. O `SessionController`
e o registro do workspace são **fixtures explícitas de teste**, e não
persistência oficial nem um Lead vivo. Não há modelo, rede externa,
segredo operacional, grant real ou alteração da VPS.

**Critério e limite de evidência:** só marcar o novo gate como GREEN se
o workflow `CI` da PR #71 concluir SUCCESS no mesmo SHA revisado. A
separada workflow `DeepHarness semantic read-write policy gate` não
substitui este teste. Mesmo GREEN não libera o relay, a configuração
`semanticBridge.enabled`, os `dsh_*` nem uma instrução a Lead real.
Para ativação futura, exigir certificado cliente pinado pelo DSH,
fingerprint confiável do servidor no relay, socket com proprietário/grupo
revisados, target `deepharness-semantic-lab` diferente do
`deepharness-read`, identidade e grants exatos, além de readback
independente após admissão de uma instrução de laboratório aprovada.

O DeepHarness da stack 90 permanece protegido por fluxo separado.
