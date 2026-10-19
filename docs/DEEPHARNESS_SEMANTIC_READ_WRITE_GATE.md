# DeepHarness Agent Teams via connected Remote-Ops MCP — read AND write

Status 2026-10-19: Draft engineering only; NO-GO for production.
Owner authorized development of reading and writing through the existing ChatGPT
Wandora MCP. This does not authorize sending real messages, deploying a stack,
changing target authority or exposing a listener.

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
