import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(base, "dist", "dsh", "runner.js");

const run = (value) => spawnSync(process.execPath, [runner], {
  input: JSON.stringify(value) + "\n",
  cwd: base,
  encoding: "utf8",
  timeout: 7000,
  env: {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp",
    CHUTES_API_KEY: "should-not-be-used",
  },
});
const req = {
  request_id: "ci_contract_1",
  expected_sha: "a".repeat(40),
  task: "Relatar estado sintetico sem alterar nenhum arquivo.",
};
const blocked = run({ ...req, cwd: "/etc" });
assert.equal(blocked.status, 1);
assert.match(blocked.stdout, /"type":"failure","code":"task_denied"/);
assert.doesNotMatch(blocked.stdout + blocked.stderr, /should-not-be-used/);
assert.doesNotMatch(blocked.stdout, /"type":"started"/);

if (process.platform === "linux") {
  const invalidWorkspace = run(req);
  assert.equal(invalidWorkspace.status, 1);
  assert.match(invalidWorkspace.stdout, /"type":"failure","code":"checkout_gate_denied"/);
  assert.doesNotMatch(invalidWorkspace.stdout, /"type":"started"/);
  assert.doesNotMatch(invalidWorkspace.stdout + invalidWorkspace.stderr, /should-not-be-used/);
}
console.log("dsh runner negative gates: PASS (no dsh or provider execution)");
