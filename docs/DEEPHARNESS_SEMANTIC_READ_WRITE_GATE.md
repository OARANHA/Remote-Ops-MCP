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
2. Use the verified Remote-Ops OAuth client/session tuple as the call principal;
   create exact workspace/Lead/action grants through a separate administrator
   path. Never infer an individual Keycloak subject from Remote-Ops OAuth.
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
no new dsh_* tools are registered until the host Agent Mesh bridge and explicit
workspace/Lead/action grants are installed and canary-tested.


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

The current ChatGPT MCP tool registry exposes no semantic `dsh_*` operation.
The running DSH Web container starts the private MCP host and mounts its mTLS
server key, certificate chain and CA. Its operational configuration binds the
backend listener on port 3443 inside `deepharness_mcp-private`; Docker publishes
no port. The Wandora `deepharness-read` target remains read-only with zero
semantic capabilities, and no authenticated Agent Mesh transport/client identity
to that listener is configured or proven. No synthetic instruction was sent.

DeepHarness PR #4 remains Draft and is based on a non-main branch. Its proposed
read-only MCP connector uses its own OAuth/Keycloak flow; it does not provide a
ready write bridge for the existing Remote-Ops MCP and is not being adopted as
an implicit dependency.

**Decision:** keep production NO-GO and preserve `deepharness-read` unchanged.
Continue with a fixed-operation Agent Mesh transport to the existing private
mTLS host interface, persistent grants/idempotency and exact owner-admin grant
provisioning. Preserve the read-only target. Run the authorized synthetic
canary only against a disposable lab session after the transport is tested.
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


## Stage 8 — current workflow and private transport reconciliation (2026-10-19)

PR #71 remains open, Draft and unmerged at head
`70f0246a8d0b7b27c1e6cd08ad1e2994fe7ed5e9`. CI run #256 and the DeepHarness
semantic read-write policy gate #20 both completed successfully. These workflows
validate repository checks; they do not activate the integration.

A fresh safe container inspection confirms `deepharness-web-1` runs the
operational DSH MCP host image on `deepharness_mcp-private`. The host mounts
its backend TLS server key/chain and CA and is configured to listen on private
backend port 3443. Docker has no published port binding. This is an existing
mTLS host interface, but not a callable bridge from the Wandora Agent Mesh:
the current target is read-only with zero semantic capabilities, and no
authenticated agent transport/client identity or grant provisioning is wired.

The Remote-Ops OAuth client/session is the current call principal; it is not an
individual Keycloak subject. Separate administrator-provisioned grants must
bind that exact principal to workspace, Lead and action. No production target
or credentials changed, and no instruction was sent. Production remains
**NO-GO**.

The next implementation must connect fixed semantic operations to the private
mTLS host service and prove read/write behavior against a disposable official
DSH host. Do not create an HTTP-to-shell adapter, broaden the read target, or
treat an mTLS server certificate as a client credential.
