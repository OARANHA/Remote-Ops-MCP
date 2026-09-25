import assert from "node:assert/strict";
import { normalizePaperclipSemanticPayload, paperclipSemanticExecCommand } from "./dist/docker/paperclip-semantic.js";

const companyId = "5d7ec217-118c-4292-8136-0a9ab16926ea";
const payload = normalizePaperclipSemanticPayload("tool-policy-test", {
  companyId,
  actor: { actorType: "user", actorId: "owner-test" },
  request: { toolName: "vendaerp_search_products", arguments: { pageSize: 5, skip: 0 }, sideEffecting: false },
  consumeRateLimit: true,
  writeAuditEvent: true,
});
assert.equal(payload.consumeRateLimit, false);
assert.equal(payload.writeAuditEvent, false);
assert.equal(payload.companyId, companyId);

const list = normalizePaperclipSemanticPayload("tool-policies-list", { companyId, extra: "ignored" });
assert.deepEqual(list, { companyId });
const activity = normalizePaperclipSemanticPayload("tool-connection-activity-safe", {
  companyId,
  connectionId: "8e2c23f4-73f5-444a-8647-71428819ea91",
  limit: 20,
  runId: "d6ec458f-31ce-43f6-a2ae-60da58ac1c32",
  toolName: "vendaerp_search_products",
});
assert.deepEqual(activity, {
  companyId,
  connectionId: "8e2c23f4-73f5-444a-8647-71428819ea91",
  limit: 20,
  runId: "d6ec458f-31ce-43f6-a2ae-60da58ac1c32",
  toolName: "vendaerp_search_products",
});
assert.throws(() => normalizePaperclipSemanticPayload("tool-connection-activity-safe", {
  companyId,
  connectionId: "8e2c23f4-73f5-444a-8647-71428819ea91",
  limit: 101,
  runId: "d6ec458f-31ce-43f6-a2ae-60da58ac1c32",
  toolName: "vendaerp_search_products",
}), /invalid_activity_limit/);
assert.deepEqual(normalizePaperclipSemanticPayload("task-drain-status", { anything: "ignored" }), {});

const cmd = paperclipSemanticExecCommand("tool-policy-test", payload);
assert.equal(cmd[0], "node");
assert.equal(cmd.includes("curl"), false);
assert.equal(cmd.join(" ").includes("Bearer "), false);
assert.equal(cmd.join(" ").includes("board-token"), false);
assert.equal(cmd.join(" ").includes("/paperclip/operator-cli/activation-v1/auth.json"), true);
assert.equal(cmd.join(" ").includes("oldestCreatedAt"), true);
assert.equal(cmd.join(" ").includes("matchingRunToolCount"), true);
assert.equal(cmd.join(" ").includes("data?.structuredContent?.error"), true);

console.log("PAPERCLIP_SEMANTIC_TEST_OK");

const drainStart = normalizePaperclipSemanticPayload("task-drain-start", { ttlMs: 600000, ignored: true });
assert.deepEqual(drainStart, { ttlMs: 600000 });
assert.deepEqual(normalizePaperclipSemanticPayload("task-drain-stop", { ignored: true }), {});
assert.throws(() => normalizePaperclipSemanticPayload("task-drain-start", { ttlMs: 0 }), /invalid_ttl_ms/);

const block = normalizePaperclipSemanticPayload("tool-policy-create", {
  companyId,
  name: "wandora-adr0257-block",
  policyType: "block",
  priority: 1,
  selectors: {
    agentId: "428b6730-3df4-4b92-b90a-a87f87c401f9",
    connectionId: "8e2c23f4-73f5-444a-8647-71428819ea91",
    toolNames: ["vendaerp_probe","vendaerp_search_orders"],
  },
});
assert.equal(block.policyType, "block");
assert.equal(block.enabled, true);
assert.equal(block.config, null);

const rate = normalizePaperclipSemanticPayload("tool-policy-create", {
  companyId,
  name: "wandora-adr0257-rate",
  policyType: "rate_limit",
  priority: 2,
  selectors: {
    agentId: "428b6730-3df4-4b92-b90a-a87f87c401f9",
    connectionId: "8e2c23f4-73f5-444a-8647-71428819ea91",
    catalogEntryId: "165fcdca-8021-41dd-90e5-f0f143adeac3",
    toolName: "vendaerp_search_products",
  },
  config: { limit: 1, windowSeconds: 3600, keyBy: ["agent","tool"] },
});
assert.deepEqual(rate.config, { limit: 1, windowSeconds: 3600, keyBy: ["agent","tool"] });
assert.throws(() => normalizePaperclipSemanticPayload("tool-policy-create", {
  companyId, name:"bad", policyType:"block", selectors:{danger:"x"}
}), /unsupported_selector/);
assert.throws(() => normalizePaperclipSemanticPayload("tool-policy-create", {
  companyId, name:"bad", policyType:"allow", selectors:{toolName:"x"}
}), /unsupported_policy_type/);

const deletion = normalizePaperclipSemanticPayload("tool-policy-delete", {
  companyId,
  policyId: "11111111-1111-4111-8111-111111111111",
  expectedName: "wandora-adr0257-rate",
});
assert.equal(deletion.expectedName, "wandora-adr0257-rate");

for (const op of ["task-drain-start","task-drain-stop","tool-policy-create","tool-policy-delete"]) {
  const payloadByOp = {
    "task-drain-start": drainStart,
    "task-drain-stop": {},
    "tool-policy-create": rate,
    "tool-policy-delete": deletion,
  };
  const c = paperclipSemanticExecCommand(op, payloadByOp[op]);
  assert.equal(c.join(" ").includes("Bearer "), false);
  assert.equal(c.join(" ").includes("curl"), false);
}
