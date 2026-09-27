#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ops-disclosure-"));
process.env.STATE_FILE = path.join(tmp, "state.json");
process.env.AUDIT_FILE = path.join(tmp, "audit.jsonl");
process.env.TARGETS_FILE = path.join(tmp, "targets.json");
process.env.AUTH_MODE = "noauth";

fs.writeFileSync(process.env.TARGETS_FILE, JSON.stringify({
  targets: [{
    id: "medicspro-agent",
    transport: "mock",
    environment: "production",
    capabilityProfile: "operator",
    enabled: true,
    allowedPaths: ["/opt/medicspro/private-runtime"],
    allowedWritePaths: ["/opt/medicspro/private-runtime"],
    allowedProcessCwds: ["/opt/medicspro/private-runtime"],
    allowedProcessPrograms: ["bash","git"],
    allowedServices: ["medicspro-agent.service"],
    allowedServiceActions: ["restart"]
  }]
}, null, 2));

try {
  const state = await import("./dist/state/store.js");
  const targets = await import("./dist/config/targets.js");
  const tools = await import("./dist/tools/index.js");

  state.initStateStore();
  targets.loadRegistry();

  const targetStatus = tools.TOOL_DEFS.find((item) => item.name === "target_status");
  const targetsList = tools.TOOL_DEFS.find((item) => item.name === "targets_list");
  assert.ok(targetStatus);
  assert.ok(targetsList);

  const ctx = { actor: "test", requestId: "req_test" };
  const summary = await targetStatus.run({ target: "medicspro-agent" }, ctx);
  const summaryText = JSON.stringify(summary);

  assert.equal(summary.id, "medicspro-agent");
  assert.equal(summary.capabilityProfile, "operator");
  assert.equal(summary.capabilityBaseline.workspace_write_roots, 1);
  assert.equal(summary.capabilityBaseline.process_programs, 2);
  assert.equal(summaryText.includes("/opt/medicspro/private-runtime"), false);
  assert.equal(summaryText.includes('"bash"'), false);
  assert.equal(Object.hasOwn(summary, "allowedPaths"), false);

  const full = await targetStatus.run({ target: "medicspro-agent", detail: "full" }, ctx);
  assert.deepEqual(full.allowedPaths, ["/opt/medicspro/private-runtime"]);
  assert.deepEqual(full.allowedProcessPrograms, ["bash","git"]);

  const listed = await targetsList.run({}, ctx);
  const listedText = JSON.stringify(listed);
  assert.equal(listedText.includes("/opt/medicspro/private-runtime"), false);
  assert.equal(listedText.includes('"bash"'), false);

  console.log("OPERATOR_CHAT_MINIMAL_DISCLOSURE_V1=GREEN");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
