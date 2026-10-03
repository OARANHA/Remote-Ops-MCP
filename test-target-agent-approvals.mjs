#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ops-target-approval-"));
process.env.STATE_FILE = path.join(tmp, "state.json");
process.env.AUDIT_FILE = path.join(tmp, "audit.jsonl");
process.env.TARGETS_FILE = path.join(tmp, "targets.json");
process.env.AUTH_MODE = "oauth";
process.env.AUTH_SECRET = "managed-admin-target-test-secret-".padEnd(64, "x");

fs.writeFileSync(process.env.TARGETS_FILE, JSON.stringify({
  targets: [{
    id: "wandora-agent",
    transport: "mock",
    environment: "production",
    capabilityProfile: "operator",
    enabled: true
  }]
}, null, 2));

try {
  const state = await import("./dist/state/store.js");
  const targets = await import("./dist/config/targets.js");
  const approvals = await import("./dist/config/target-approvals.js");

  state.initStateStore();
  targets.loadRegistry();

  assert.deepEqual(targets.targetIds(), ["wandora-agent"]);

  const pairing = state.createPairing({ hostname: "28server", os: "Ubuntu test", agent_version: "test" });
  assert.ok(state.approvePairingByCode(pairing.code));
  const claimed = state.claimPairing(pairing.pairing_id, pairing.poll_token);
  assert.equal(claimed.status, "paired");
  if (claimed.status !== "paired") throw new Error("pairing failed");
  const deviceId = claimed.device.device_id;
  assert.match(deviceId, /^dev_/);
  assert.equal(state.touchDeviceHeartbeat(deviceId, { agent_version: "test", capabilities: ["host","workspace","process"] }), true);

  const prepared = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "medicspro-agent",
    deviceId,
    environment: "production",
    preset: "operator-workspace",
  });

  assert.match(prepared.approval_id, /^adm_[a-f0-9]{24}$/);
  assert.equal(prepared.applied, false);
  assert.equal(targets.getTarget("medicspro-agent"), undefined, "prepare must not mutate registry");

  assert.throws(
    () => approvals.applyAgentTargetApproval({
      actor: "test-actor",
      approvalId: prepared.approval_id,
      confirmation: "APPROVE wrong",
    }),
    /confirmação inválida/
  );
  assert.equal(targets.getTarget("medicspro-agent"), undefined);

  assert.throws(
    () => approvals.applyAgentTargetApproval({
      actor: "other-actor",
      approvalId: prepared.approval_id,
      confirmation: `APPROVE ${prepared.approval_id}`,
    }),
    /outro ator/
  );

  const applied = approvals.applyAgentTargetApproval({
    actor: "test-actor",
    approvalId: prepared.approval_id,
    confirmation: `APPROVE ${prepared.approval_id}`,
  });

  assert.equal(applied.applied, true);
  const target = targets.getTarget("medicspro-agent");
  assert.ok(target);
  assert.equal(target.transport, "agent");
  assert.equal(target.deviceId, deviceId);
  assert.equal(target.capabilityProfile, "operator");
  assert.deepEqual(target.allowedWritePaths, ["/opt/wandora/ops-workspace"]);
  assert.deepEqual(target.allowedProcessCwds, ["/opt/wandora/ops-workspace"]);
  assert.ok(target.allowedProcessPrograms.includes("bash"));
  assert.deepEqual(target.allowedDockerActions, []);
  assert.equal(targets.getTarget("wandora-agent")?.transport, "mock", "static target must remain unchanged");

  const dynamicFile = path.join(tmp, "dynamic-targets.json");
  assert.ok(fs.existsSync(dynamicFile));
  const dynamic = JSON.parse(fs.readFileSync(dynamicFile, "utf8"));
  assert.equal(dynamic.targets.length, 1);
  assert.equal(dynamic.targets[0].id, "medicspro-agent");

  const preparedReadOnly = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "medicspro-agent",
    deviceId,
    environment: "production",
    preset: "read-only",
  });
  approvals.applyAgentTargetApproval({
    actor: "test-actor",
    approvalId: preparedReadOnly.approval_id,
    confirmation: `APPROVE ${preparedReadOnly.approval_id}`,
  });
  assert.equal(targets.getTarget("medicspro-agent")?.capabilityProfile, "read-only");

  const preparedPostgres = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "medicspro-db-readback",
    deviceId,
    environment: "production",
    preset: "postgres-readback",
  });
  const appliedPostgres = approvals.applyAgentTargetApproval({
    actor: "test-actor",
    approvalId: preparedPostgres.approval_id,
    confirmation: `APPROVE ${preparedPostgres.approval_id}`,
  });
  assert.equal(appliedPostgres.applied, true);
  const postgresTarget = targets.getTarget("medicspro-db-readback");
  assert.ok(postgresTarget);
  assert.equal(postgresTarget.capabilityProfile, "read-only");
  assert.deepEqual(postgresTarget.allowedSemanticCapabilities, ["postgres.pinned_readback"]);
  assert.deepEqual(postgresTarget.allowedDockerContainers, []);
  assert.deepEqual(postgresTarget.allowedDockerExecContainers, []);
  assert.deepEqual(postgresTarget.allowedProcessPrograms, []);
  assert.deepEqual(postgresTarget.allowedWritePaths, []);

  const preparedElusCanary = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "vigia-elus-danfe-canary",
    deviceId,
    environment: "production",
    preset: "elus-danfe-canary",
  });
  const appliedElusCanary = approvals.applyAgentTargetApproval({
    actor: "test-actor",
    approvalId: preparedElusCanary.approval_id,
    confirmation: `APPROVE ${preparedElusCanary.approval_id}`,
  });
  assert.equal(appliedElusCanary.applied, true);
  const elusCanaryTarget = targets.getTarget("vigia-elus-danfe-canary");
  assert.ok(elusCanaryTarget);
  assert.equal(elusCanaryTarget.capabilityProfile, "operator");
  assert.deepEqual(elusCanaryTarget.allowedSemanticCapabilities, ["elus.vendaerp_danfe_canary_readonly"]);
  assert.deepEqual(elusCanaryTarget.allowedDockerContainers, []);
  assert.deepEqual(elusCanaryTarget.allowedDockerExecContainers, []);
  assert.deepEqual(elusCanaryTarget.allowedDockerActions, []);
  assert.deepEqual(elusCanaryTarget.allowedProcessPrograms, []);
  assert.deepEqual(elusCanaryTarget.allowedWritePaths, []);

  assert.throws(
    () => approvals.prepareAgentTarget({
      actor: "test-actor",
      targetId: "medicspro-admin",
      deviceId,
      environment: "production",
      preset: "managed-admin",
    }),
    /não anunciou host\.managed_admin/
  );

  assert.equal(state.touchDeviceHeartbeat(deviceId, {
    agent_version: "test",
    capabilities: ["host","workspace","process","host.managed_admin"],
  }), true);

  const preparedAdmin = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "medicspro-admin",
    deviceId,
    environment: "production",
    preset: "managed-admin",
  });
  const appliedAdmin = approvals.applyAgentTargetApproval({
    actor: "test-actor",
    approvalId: preparedAdmin.approval_id,
    confirmation: `APPROVE ${preparedAdmin.approval_id}`,
  });
  assert.equal(appliedAdmin.applied, true);
  const adminTarget = targets.getTarget("medicspro-admin");
  assert.ok(adminTarget);
  assert.equal(adminTarget.capabilityProfile, "operator");
  assert.deepEqual(adminTarget.allowedSemanticCapabilities, ["host.managed_admin"]);
  assert.ok(adminTarget.allowedAdminPrograms.includes("docker"));
  assert.equal(adminTarget.allowedAdminPrograms.includes("bash"), false);
  assert.deepEqual(adminTarget.allowedAdminCwds, ["/opt/wandora/ops-workspace","/opt/wandora"]);
  assert.deepEqual(adminTarget.allowedDockerActions, []);

  const staticAttempt = approvals.prepareAgentTarget({
    actor: "test-actor",
    targetId: "wandora-agent",
    deviceId,
    environment: "production",
    preset: "operator-workspace",
  });
  assert.throws(
    () => approvals.applyAgentTargetApproval({
      actor: "test-actor",
      approvalId: staticAttempt.approval_id,
      confirmation: `APPROVE ${staticAttempt.approval_id}`,
    }),
    /target estático/
  );
  assert.equal(targets.getTarget("wandora-agent")?.transport, "mock");

  console.log("TARGET_AGENT_APPROVALS=GREEN");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
