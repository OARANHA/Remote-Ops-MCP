import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { composeDeepharnessReadWrite } from "./composition.mjs";

const clientId = "client-1", sessionId = "session-0123456789abcdef";
const principal = Object.freeze({ actor: "oauth:client-1:session-0123", clientId, sessionId });
const scope = Object.freeze({ workspaceId: "lab", leadSessionId: "lead-123" });
function build(overrides = {}) {
  const calls = { grants: 0, projections: 0, reads: 0, prompts: 0, commits: 0 };
  let enabled = true;
  const deps = {
    async lookupCurrentGrant(identity) {
      calls.grants++;
      return enabled ? { ...identity, revision: "revision-1",
        actions: ["team.read", "chat.read", "lead.instruct"] } : null;
    },
    workspaceRegistry: { get(id) { return id === "lab" ?
      { sessionIds: new Set(["lead-123"]) } : null; } },
    sessionController: {
      async projections() {
        calls.projections++;
        return { kind: "sequenced", asOfSeq: 20, values: { agentTeam: {
          members: [{ id: "lead-123", role: "lead", name: "Lead", phase: "active" }],
          tasks: [{ id: "task-1", subject: "Work", description: "", status: "pending" }],
        } } };
      },
      async inspect() {
        calls.reads++;
        return { meta: { id: "lead-123" }, events: [
          { type: "user/message", data: { role: "user", content: [{ type: "text", text: "Synthetic test" }] } },
        ] };
      },
      async prompt() { calls.prompts++; return { accepted: true }; },
    },
    async withAuthorizedLeadCommit(auth, submit) {
      calls.commits++;
      if (!enabled) throw new Error("grant_revoked");
      await submit();
      return { accepted: true, authorizationCheckedAtCommit: true,
        grantRevision: auth.revision, messageId: "message-1", duplicate: false };
    },
    ...overrides,
  };
  return { calls, policy: composeDeepharnessReadWrite(deps), revoke() { enabled = false; } };
}

test("end-to-end synthetic chain reads the exact allowed Lead only", async () => {
  const f = build();
  const result = await f.policy.readTeam(principal, scope);
  assert.equal(result.lead_session_id, "lead-123");
  assert.equal(result.members[0].name, "Lead");
  assert.deepEqual(result.tasks.map(t => t.subject), ["Work"]);
  const chat = await f.policy.readChat(principal, { ...scope, limit: 1 });
  assert.deepEqual(chat.messages, [{ role: "user", text: "Synthetic test" }]);
  assert.equal(f.calls.grants, 4);
  assert.equal(f.calls.projections, 2);
});

test("end-to-end synthetic chain writes via official user queue, not Team spoofing", async () => {
  const f = build();
  const ack = await f.policy.sendLeadInstruction(principal, {
    ...scope, instruction: "Review the synthetic task", idempotencyKey: randomUUID(),
  });
  assert.deepEqual(ack, {
    workspace_id: "lab", lead_session_id: "lead-123",
    message_id: "message-1", accepted: true, duplicate: false,
  });
  assert.equal(f.calls.prompts, 1);
  assert.equal(f.calls.commits, 1);
  assert.ok(f.calls.grants >= 1);
});

test("no grant: no DSH projections, read or write", async () => {
  const f = build();
  f.revoke();
  await assert.rejects(f.policy.readTeam(principal, scope), /capability_denied/);
  await assert.rejects(f.policy.sendLeadInstruction(principal, {
    ...scope, instruction: "Denied", idempotencyKey: randomUUID(),
  }), /capability_denied/);
  assert.equal(f.calls.projections, 0);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.prompts, 0);
});

test("cannot bypass scope by fabricating another OAuth session", async () => {
  const f = build();
  await assert.rejects(f.policy.readTeam({ ...principal, sessionId: "another" }, scope),
    /capability_denied/);
  assert.equal(f.calls.grants, 0);
  assert.equal(f.calls.projections, 0);
});

test("missing durable write gate denies composition at construction", () => {
  assert.throws(() => composeDeepharnessReadWrite({ lookupCurrentGrant() {} }),
    /operation_denied/);
});
