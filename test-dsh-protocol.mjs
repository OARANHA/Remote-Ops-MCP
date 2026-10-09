import assert from "node:assert/strict";
import { CANONICAL_PATHS, parseTaskRequest, canonicalTaskPrompt, safeDshEvent } from "./dist/dsh/protocol.js";

const sha = "a".repeat(40);
const req = { request_id: "v1_test", expected_sha: sha, task: "Verificar testes sintéticos e relatar resultados" };

const parsed = parseTaskRequest(req);
assert.equal(parsed.expected_sha, sha);
assert.equal(parsed.request_id, "v1_test");
assert.match(canonicalTaskPrompt(parsed), /REAL NOW/);
for (const file of CANONICAL_PATHS) assert.ok(canonicalTaskPrompt(parsed).includes(file));

for (const invalid of [
  null,
  [],
  { ...req, expected_sha: "HEAD" },
  { ...req, request_id: "../../escape" },
  { ...req, task: "a" },
  { ...req, session_id: "session-fake" },
  { ...req, cwd: "/tmp/outside" },
  { ...req, model: "some-unapproved-model" },
  { ...req, task: "CHUTES_API_KEY=abcdef0123456789" },
  { ...req, task: "sk-012345678901234567890123" },
]) assert.throws(() => parseTaskRequest(invalid), undefined, JSON.stringify(invalid));

const session = "session-c980ab9d-d4f0-4bf1-a7d9-e53025e8a233";
assert.deepEqual(safeDshEvent({ type: "session", sessionId: session, cwd: "/private/path" }), { type: "session", session_id: session });
assert.deepEqual(safeDshEvent({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { sensitive: "leak" } }), { type: "status", phase: "step_end", turn: 1, step: 2 });
assert.deepEqual(safeDshEvent({ type: "final", text: "Tudo OK" }), { type: "final", text: "Tudo OK" });

assert.equal(safeDshEvent({ type: "thinking", text: "private reasoning" }), null);
assert.equal(safeDshEvent({ type: "text", text: "unsanitized intermediate response" }), null);
assert.equal(safeDshEvent({ type: "tool_call", args: { password: "secret" } }), null);
assert.equal(safeDshEvent({ type: "error", message: "api key exposed" }), null);
assert.equal(safeDshEvent({ type: "status", phase: "new_future_phase", text: "leak" }), null);
assert.equal(safeDshEvent({ type: "session", sessionId: "other", cwd: "/other" }), null);
assert.deepEqual(safeDshEvent({ type: "final", text: "Bearer abcdefghijklmnop" }), { type: "final", text: "[REDACTED]" });
assert.equal(safeDshEvent({ type: "final", text: "x".repeat(6000) }).text.length, 4000);

console.log("dsh protocol tests: PASS (task schema, canonical memory prompt, sensitive event drops, redaction)");
