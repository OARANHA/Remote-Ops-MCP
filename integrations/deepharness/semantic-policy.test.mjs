import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDeepharnessSemanticPolicy } from "./semantic-policy.mjs";

const clientId = "client-1";
const sessionId = "session-0123456789abcdef";
const ctx = Object.freeze({
  actor: "oauth:" + clientId + ":" + sessionId.slice(0, 12),
  clientId, sessionId,
});
const scope = Object.freeze({ workspaceId: "lab", leadSessionId: "lead-123" });
const instruction = "Lead, summarize the synthetic lab tasks.";
function fixture(overrides = {}) {
  const calls = { grants: 0, reads: 0, chats: 0, sends: 0, lists: 0 };
  let enabled = true, revision = "revision-1";
  const deps = {
    async lookupCurrentGrant(identity) {
      calls.grants++;
      return enabled ? {
        ...identity, revision,
        actions: ["team.read", "chat.read", "lead.instruct"],
      } : null;
    },
    async readAuthorizedTeam(auth) {
      calls.reads++;
      return { workspace: auth.workspaceId, tasks: [] };
    },
    async readAuthorizedChat(auth) {
      calls.chats++;
      return { limit: auth.limit, messages: [] };
    },
    async commitAuthorizedInstruction(auth) {
      calls.sends++;
      return { accepted: true, authorizationCheckedAtCommit: true,
        grantRevision: auth.revision, receiptId: "receipt-123", duplicate: false };
    },
    async listCurrentLeadGrants(input) {
      calls.lists++;
      return input.workspaceId === scope.workspaceId
        ? [{workspaceId:scope.workspaceId,leadSessionId:scope.leadSessionId,revision:"revision-1"}]
        : [];
    },
    ...overrides,
  };
  return {
    calls, deps, policy: createDeepharnessSemanticPolicy(deps),
    revoke() { enabled = false; }, rotate() { revision = "revision-2"; },
  };
}

test("without a complete trusted backend, fails closed", () => {
  assert.throws(() => createDeepharnessSemanticPolicy({}), /capability_denied/);
});

test("Lead discovery enumerates grants only and rechecks each Lead before returning it",async()=>{
  const f=fixture();
  assert.deepEqual(await f.policy.listTeams(ctx,{workspaceId:scope.workspaceId}),[
    {workspace:scope.workspaceId,tasks:[]},
  ]);
  assert.equal(f.calls.lists,1);
  assert.equal(f.calls.reads,1);
  assert.equal(f.calls.grants,2);
  await assert.rejects(f.policy.listTeams(ctx,{workspaceId:scope.workspaceId,leadSessionId:"untrusted"}),/capability_denied/);
});

test("no authenticated client/session means zero backend reads and writes", async () => {
  const f = fixture();
  await assert.rejects(f.policy.readTeam({ actor: ctx.actor }, scope), /capability_denied/);
  await assert.rejects(f.policy.sendLeadInstruction({ actor: "oauth:x:x" },
    { ...scope, instruction, idempotencyKey: randomUUID() }), /capability_denied/);
  assert.equal(f.calls.grants, 0);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.sends, 0);
});

test("read model and chat are scoped and checked again for revocation", async () => {
  const f = fixture();
  assert.deepEqual(await f.policy.readTeam(ctx, scope), { workspace: "lab", tasks: [] });
  assert.deepEqual(await f.policy.readChat(ctx, { ...scope, limit: 2 }), { limit: 2, messages: [] });
  assert.equal(f.calls.grants, 4);
  f.revoke();
  await assert.rejects(f.policy.readTeam(ctx, scope), /capability_denied/);
  assert.equal(f.calls.reads, 1);
});

test("reject mismatched grant and wrong workspace before reading", async () => {
  const f = fixture({ async lookupCurrentGrant(identity) {
    return { ...identity, workspaceId: "other", revision: "revision-1", actions: ["team.read"] };
  }});
  await assert.rejects(f.policy.readTeam(ctx, scope), /capability_denied/);
  assert.equal(f.calls.reads, 0);
});

test("deny access when grant is revoked while reader is pending", async () => {
  let lookupCount = 0;
  const f = fixture({
    async lookupCurrentGrant(identity) {
      lookupCount++;
      return lookupCount === 1
        ? { ...identity, revision: "r1", actions: ["team.read"] }
        : null;
    },
  });
  await assert.rejects(f.policy.readTeam(ctx, scope), /capability_denied/);
  assert.equal(f.calls.reads, 1);
});

test("deny reads on grant revision changes, not just action presence", async () => {
  const f = fixture({
    async lookupCurrentGrant(identity) {
      f.calls.grants++;
      return { ...identity, revision: f.calls.grants === 1 ? "v1" : "v2", actions: ["team.read"] };
    },
  });
  await assert.rejects(f.policy.readTeam(ctx, scope), /capability_denied/);
});

test("read capability cannot implicitly authorize a write", async () => {
  const f = fixture({ async lookupCurrentGrant(identity) {
    return { ...identity, revision: "r1", actions: ["team.read", "chat.read"] };
  }});
  await assert.rejects(f.policy.sendLeadInstruction(ctx,
    { ...scope, instruction, idempotencyKey: randomUUID() }), /capability_denied/);
  assert.equal(f.calls.sends, 0);
});

test("reject unsupported, large and malformed write inputs before commit", async () => {
  const f = fixture();
  for (const input of [
    { instruction: "", idempotencyKey: randomUUID() },
    { instruction: "x".repeat(4097), idempotencyKey: randomUUID() },
    { instruction, idempotencyKey: "not-uuid" },
    { instruction: "hi\0", idempotencyKey: randomUUID() },
  ]) {
    await assert.rejects(f.policy.sendLeadInstruction(ctx, { ...scope, ...input }), /capability_denied/);
  }
  assert.equal(f.calls.sends, 0);
});

test("the DSH commit provider must attest atomic grant and revision checks", async () => {
  const f = fixture({ async commitAuthorizedInstruction() {
    f.calls.sends++;
    return { accepted: true, receiptId: "receipt-123", duplicate: false };
  }});
  await assert.rejects(f.policy.sendLeadInstruction(ctx,
    { ...scope, instruction, idempotencyKey: randomUUID() }), /capability_denied/);
  assert.equal(f.calls.sends, 1);
});

test("authorized write returns only idempotent acknowledgement, not text", async () => {
  const f = fixture({
    async commitAuthorizedInstruction(auth) {
      assert.equal(auth.actor, ctx.actor);
      assert.equal(auth.workspaceId, scope.workspaceId);
      assert.equal(auth.leadSessionId, scope.leadSessionId);
      assert.equal(auth.instruction, instruction);
      assert.match(auth.idempotencyKey, /^[0-9a-f-]{36}$/);
      return { accepted: true, authorizationCheckedAtCommit: true,
        grantRevision: auth.revision, receiptId: "receipt-123", duplicate: true,
        untrustedSecret: "MUST_NOT_RETURN" };
    },
  });
  const out = await f.policy.sendLeadInstruction(ctx,
    { ...scope, instruction, idempotencyKey: randomUUID() });
  assert.deepEqual(out, { workspace_id: "lab", lead_session_id: "lead-123",
    receipt_id: "receipt-123", accepted: true, duplicate: true });
  assert.doesNotMatch(JSON.stringify(out), /MUST_NOT_RETURN|summarize/);
});

test("invalid chat page limit is denied without fetching messages", async () => {
  const f = fixture();
  await assert.rejects(f.policy.readChat(ctx, { ...scope, limit: 900 }), /capability_denied/);
  assert.equal(f.calls.chats, 0);
});
