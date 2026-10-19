import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPersistentDshGrantStore } from "./persistent-grant-store.mjs";

const identity = Object.freeze({
  actor: "oauth:chatgpt-client:session-1234",
  clientId: "chatgpt-client",
  sessionId: "session-123456789",
  workspaceId: "lab-workspace",
  leadSessionId: "lab-lead",
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-grants-"));
  const file = join(directory, "grants.json");
  const store = createPersistentDshGrantStore({ file });
  const grant = await store.putGrant({ ...identity, actions: ["team.read", "chat.read", "lead.instruct"] });
  return { directory, file, store, grant };
}

test("grant is exact to OAuth client/session, workspace, Lead, and actions", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const read = await f.store.lookupCurrentGrant(identity);
  assert.equal(read.revision, f.grant.revision);
  assert.deepEqual(read.actions, ["chat.read", "lead.instruct", "team.read"]);
  for (const field of ["workspaceId", "leadSessionId"]) {
    assert.equal(await f.store.lookupCurrentGrant({ ...identity, [field]: "other" }), null);
  }
  for (const field of ["clientId", "sessionId"]) {
    await assert.rejects(f.store.lookupCurrentGrant({ ...identity, [field]: "other" }), /grant_denied/);
  }
});

test("parallel duplicate commit sends once and returns the durable receipt", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const idempotencyKey = randomUUID();
  const input = { ...identity, action: "lead.instruct", revision: f.grant.revision,
    idempotencyKey, payloadHash: "a".repeat(64) };
  let sends = 0;
  const submit = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { accepted: true }; };
  const [first, second] = await Promise.all([
    f.store.withAuthorizedLeadCommit(input, submit),
    f.store.withAuthorizedLeadCommit(input, submit),
  ]);
  assert.equal(sends, 1);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("same idempotency key cannot carry changed instruction content", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const input = { ...identity, action: "lead.instruct", revision: f.grant.revision,
    idempotencyKey: randomUUID(), payloadHash: "b".repeat(64) };
  await f.store.withAuthorizedLeadCommit(input, async () => ({ accepted: true }));
  await assert.rejects(f.store.withAuthorizedLeadCommit({ ...input, payloadHash: "c".repeat(64) },
    async () => ({ accepted: true })), /idempotency_conflict/);
});

test("revocation waits for an in-flight commit, then denies subsequent writes", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const input = { ...identity, action: "lead.instruct", revision: f.grant.revision,
    idempotencyKey: randomUUID(), payloadHash: "d".repeat(64) };
  let sendStarted;
  const entered = new Promise(resolve => { sendStarted = resolve; });
  const write = f.store.withAuthorizedLeadCommit(input, async () => {
    sendStarted(); await started; return { accepted: true };
  });
  await entered;
  const revoke = f.store.revokeGrant(identity);
  release();
  await write;
  assert.equal(await revoke, true);
  assert.equal(await f.store.lookupCurrentGrant(identity), null);
  await assert.rejects(f.store.withAuthorizedLeadCommit(input, async () => ({ accepted: true })), /grant_denied/);
});

test("accepted receipt and grant survive restart; instruction text is not persisted", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const instruction = "synthetic laboratory instruction - private payload";
  const { createHash } = await import("node:crypto");
  const input = { ...identity, action: "lead.instruct", revision: f.grant.revision,
    idempotencyKey: randomUUID(), payloadHash: createHash("sha256").update(instruction).digest("hex") };
  let sends = 0;
  const first = await f.store.withAuthorizedLeadCommit(input, async () => { sends++; return { accepted: true }; });
  const restarted = createPersistentDshGrantStore({ file: f.file });
  const retry = await restarted.withAuthorizedLeadCommit(input, async () => { sends++; return { accepted: true }; });
  const persisted = await readFile(f.file, "utf8");
  assert.equal(sends, 1);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.receiptId, first.receiptId);
  assert.equal(persisted.includes(instruction), false);
});

test("grant store file is private and a symlink store path is denied", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  if (process.platform !== "win32") {
    assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  }
  const link = join(f.directory, "linked-grants.json");
  const { symlink } = await import("node:fs/promises");
  await symlink(f.file, link);
  assert.throws(() => createPersistentDshGrantStore({ file: link }), /grant_denied/);
});

test("failed prompt keeps a retryable durable intent with the same request idempotency", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const input = { ...identity, action: "lead.instruct", revision: f.grant.revision,
    idempotencyKey: randomUUID(), payloadHash: "e".repeat(64) };
  let dshAdmissions = 0;
  const dshSeenRequestIds = new Set();
  let loseFirstAck = true;
  const submit = async () => {
    const requestId = `mcp-${input.idempotencyKey}`;
    if (!dshSeenRequestIds.has(requestId)) { dshSeenRequestIds.add(requestId); dshAdmissions++; }
    if (loseFirstAck) { loseFirstAck = false; throw new Error("ack_lost_after_durable_admission"); }
    return { accepted: true };
  };
  await assert.rejects(f.store.withAuthorizedLeadCommit(input, submit), /ack_lost/);
  const restarted = createPersistentDshGrantStore({ file: f.file });
  const ack = await restarted.withAuthorizedLeadCommit(input, submit);
  assert.equal(ack.accepted, true);
  assert.equal(ack.duplicate, false);
  assert.equal(dshAdmissions, 1);
});

test("missing identity, invalid actions, stale grants, and malformed storage fail closed", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.store.lookupCurrentGrant({ workspaceId: "lab-workspace" }), /grant_denied/);
  await assert.rejects(f.store.putGrant({ ...identity, actions: ["*"] }), /grant_denied/);
  const changed = await f.store.putGrant({ ...identity, actions: ["chat.read"] });
  const input = { ...identity, action: "lead.instruct", revision: changed.revision,
    idempotencyKey: randomUUID(), payloadHash: "f".repeat(64) };
  await assert.rejects(f.store.withAuthorizedLeadCommit(input, async () => ({ accepted: true })), /grant_denied/);
  assert.notEqual(changed.revision, f.grant.revision);
  const corrupt = join(f.directory, "corrupt.json");
  await writeFile(corrupt, "{not-json", { mode: 0o600 });
  assert.throws(() => createPersistentDshGrantStore({ file: corrupt }), /grant_denied/);
});
