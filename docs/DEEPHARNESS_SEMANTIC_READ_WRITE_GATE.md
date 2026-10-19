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
- Remote-Ops bearer middleware knows oauthClientId and oauthSessionId, but the
  MCP ToolCtx currently receives only actor and requestId.
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

1. Verify official pinned DSH 0.2.1-alpha.2 contracts for chat history and
   Lead instruction, without guessing method names or hijacking Web cookies.
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
