import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createOfficialDshHostSessionBackend } from "./official-dsh-host-session.mjs";

const lead = "lead-123";
const workspace = "lab";
const auth = Object.freeze({
  actor: "oauth:client-1:session-0123",
  workspaceId: workspace, leadSessionId: lead,
  revision: "rev-1",
});
function fixture(changes = {}) {
  const calls = { projections: 0, inspect: 0, prompt: 0, gate: 0 };
  const proj = {
    kind: "sequenced", asOfSeq: 8, values: { agentTeam: {
      members: [{ id: lead, name: "Lead", role: "lead", phase: "active" },
        { id: "agent-2", name: "Reviewer", role: "teammate", phase: "active" }],
      tasks: [{ id: "task-1", subject: "Review", description: "Test",
        status: "pending", secretExtra: "NO" }],
    }},
  };
  let allowed = true;
  const ctr = {
    async projections(request, signal) {
      assert.equal(request.sessionId, lead);
      assert.ok(signal instanceof AbortSignal);
      calls.projections++;
      return proj;
    },
    async inspect(sessionId, signal) {
      assert.equal(sessionId, lead);
      assert.ok(signal instanceof AbortSignal);
      calls.inspect++;
      return { meta: { id: lead }, events: [
        { type: "system/message", data: { role: "system", content: [{ type: "text", text: "SECRET" }] } },
        { type: "user/message", data: { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", url: "SENSITIVE" }] } },
        { type: "tool/result", data: { role: "tool", content: [{ type: "text", text: "TOOL" }] } },
        { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "Ready" }] } } },
      ] };
    },
    async prompt(request, signal) {
      calls.prompt++;
      assert.ok(signal instanceof AbortSignal);
      return { accepted: true };
    },
  };
  const registry = { get(x) { return x === workspace && allowed ? { sessionIds: new Set([lead]) } : null; } };
  const gate = async (ctx, submit) => {
    calls.gate++;
    assert.equal(ctx.leadSessionId, lead);
    assert.equal(ctx.action, "lead.instruct");
    assert.equal(ctx.revision, auth.revision);
    await submit();
    return { accepted: true, authorizationCheckedAtCommit: true,
      grantRevision: auth.revision, messageId: "msg-1", duplicate: false };
  };
  const deps = { sessionController: ctr, workspaceRegistry: registry, withAuthorizedLeadCommit: gate, ...changes };
  return { calls, ctr, registry, gate, proj, deps,
    backend: createOfficialDshHostSessionBackend(deps),
    revoke() { allowed = false; },
  };
}

test("no official host service or durable write gate denies adapter startup", () => {
  assert.throws(() => createOfficialDshHostSessionBackend({}), /operation_denied/);
  const f = fixture();
  assert.throws(() => createOfficialDshHostSessionBackend({
    sessionController: f.ctr, workspaceRegistry: f.registry,
  }), /operation_denied/);
});

test("real pinned Team projection field subject and scoped sanitized roster", async () => {
  const f = fixture();
  const r = await f.backend.readAuthorizedTeam(auth);
  assert.deepEqual(r, {
    workspace_id: workspace, lead_session_id: lead, as_of_seq: 8,
    members: [
      { id: lead, name: "Lead", role: "lead", phase: "active" },
      { id: "agent-2", name: "Reviewer", role: "teammate", phase: "active" },
    ],
    tasks: [{ id: "task-1", subject: "Review", description: "Test", status: "pending" }],
  });
  assert.doesNotMatch(JSON.stringify(r), /secretExtra|NO/);
});

test("deny wrong workspace or missing Lead before reading session", async () => {
  const f = fixture();
  await assert.rejects(f.backend.readAuthorizedTeam({ ...auth, workspaceId: "other" }), /operation_denied/);
  await assert.rejects(f.backend.readAuthorizedChat({ ...auth, workspaceId: "other", limit: 2 }), /operation_denied/);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.projections, 0);
});

test("deny arbitrary teammate, missing Team, failed projection or wrong Lead", async () => {
  const f = fixture();
  for (const altered of [
    { ...f.proj, values: {} },
    { ...f.proj, values: { agentTeam: { ...f.proj.values.agentTeam, failure: "bad event" } } },
    { ...f.proj, values: { agentTeam: { ...f.proj.values.agentTeam, members: [
      { id: lead, role: "teammate", phase: "active" }] } } },
  ]) {
    const c = fixture({
      sessionController: { ...f.ctr, async projections() { return altered; } },
    });
    await assert.rejects(c.backend.readAuthorizedTeam(auth), /operation_denied/);
  }
});

test("Lead chat includes only bounded text of human and assistant", async () => {
  const f = fixture();
  const r = await f.backend.readAuthorizedChat({ ...auth, limit: 2 });
  assert.deepEqual(r, { workspace_id: workspace, lead_session_id: lead,
    messages: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Ready" }] });
  assert.doesNotMatch(JSON.stringify(r), /SECRET|TOOL|SENSITIVE/);
  await assert.rejects(f.backend.readAuthorizedChat({ ...auth, limit: 22 }), /operation_denied/);
  assert.equal(f.calls.inspect, 1);
});

test("official SessionController.prompt gets queue, text and idempotent user requestId", async () => {
  const f = fixture();
  const key = randomUUID();
  const instruction = "Review the synthetic Team status.";
  const original = f.ctr.prompt;
  f.ctr.prompt = async (req, signal) => {
    assert.deepEqual(req, { requestId: key, sessionId: lead,
      mode: "queue", content: [{ type: "text", text: instruction }] });
    return original(req, signal);
  };
  const r = await f.backend.commitAuthorizedInstruction({
    ...auth, instruction, idempotencyKey: key,
  });
  assert.deepEqual(r, { accepted: true, authorizationCheckedAtCommit: true,
    grantRevision: "rev-1", messageId: "msg-1", duplicate: false });
  assert.equal(f.calls.gate, 1);
  assert.equal(f.calls.prompt, 1);
});

test("no fake DSH message or Team member impersonation if scope revoked", async () => {
  const f = fixture();
  f.revoke();
  await assert.rejects(f.backend.commitAuthorizedInstruction({
    ...auth, instruction: "Synthetic", idempotencyKey: randomUUID(),
  }), /operation_denied/);
  assert.equal(f.calls.gate, 0);
  assert.equal(f.calls.prompt, 0);
});

test("write rejects bad messages and idempotency keys before commit", async () => {
  const f = fixture();
  for (const [instruction, idempotencyKey] of [
    ["", randomUUID()], ["x".repeat(4097), randomUUID()],
    ["hi\0", randomUUID()], ["valid", "bad-id"],
  ]) {
    await assert.rejects(f.backend.commitAuthorizedInstruction({
      ...auth, instruction, idempotencyKey,
    }), /operation_denied/);
  }
  assert.equal(f.calls.prompt, 0);
});

test("gate cannot attest success without a verified durable authorization receipt", async () => {
  const f = fixture({ withAuthorizedLeadCommit: async () => ({ accepted: true,
    messageId: "msg-1", duplicate: false }) });
  await assert.rejects(f.backend.commitAuthorizedInstruction({
    ...auth, instruction: "Review", idempotencyKey: randomUUID(),
  }), /operation_denied/);
  assert.equal(f.calls.prompt, 0);
});

test("authorization callback rejection prevents prompt admission", async () => {
  const f = fixture({ withAuthorizedLeadCommit: async () => { throw new Error("grant_revoked"); } });
  await assert.rejects(f.backend.commitAuthorizedInstruction({
    ...auth, instruction: "Review", idempotencyKey: randomUUID(),
  }), /grant_revoked/);
  assert.equal(f.calls.prompt, 0);
});
