#!/usr/bin/env node
import assert from "node:assert/strict";

const {
  buildAgentTargetFromPreset,
  describeTargetCapabilityBaseline,
  validateAgentTargetAgainstPreset,
} = await import("./dist/config/capability-baseline.js");

const deviceId = "dev_multivpsbaseline123";

for (const targetId of ["wandora-agent", "medicspro-agent", "future-customer-agent"]) {
  const target = buildAgentTargetFromPreset({
    targetId,
    deviceId,
    environment: "production",
    preset: "operator-workspace",
  });
  const validation = validateAgentTargetAgainstPreset(target, "operator-workspace");
  assert.equal(validation.valid, true, targetId);
  assert.equal(target.capabilityProfile, "operator");
  assert.deepEqual(target.allowedDockerContainers, []);
  assert.deepEqual(target.allowedDockerExecContainers, []);
  assert.deepEqual(target.allowedDockerActions, []);
  assert.deepEqual(target.allowedSemanticCapabilities, []);
  assert.equal(describeTargetCapabilityBaseline(target).docker_actions, 0);
}

const observation = buildAgentTargetFromPreset({
  targetId: "medicspro-observe",
  deviceId,
  environment: "production",
  preset: "read-only",
});
assert.equal(validateAgentTargetAgainstPreset(observation, "read-only").valid, true);
assert.deepEqual(observation.allowedWritePaths, []);
assert.deepEqual(observation.allowedProcessPrograms, []);
assert.deepEqual(observation.allowedServiceActions, []);

const postgres = buildAgentTargetFromPreset({
  targetId: "medicspro-db-readback",
  deviceId,
  environment: "production",
  preset: "postgres-readback",
});
assert.equal(validateAgentTargetAgainstPreset(postgres, "postgres-readback").valid, true);
assert.deepEqual(postgres.allowedSemanticCapabilities, ["postgres.pinned_readback"]);
assert.deepEqual(postgres.allowedPaths, []);
assert.deepEqual(postgres.allowedDockerContainers, []);

const managed = buildAgentTargetFromPreset({
  targetId: "future-managed-admin",
  deviceId,
  environment: "production",
  preset: "managed-admin",
});
assert.equal(validateAgentTargetAgainstPreset(managed, "managed-admin").valid, true);
assert.equal(managed.allowedSemanticCapabilities.includes("host.managed_admin"), true);
assert.equal(managed.allowedAdminPrograms.includes("bash"), false);
assert.deepEqual(managed.allowedDockerActions, []);

const widened = {
  ...buildAgentTargetFromPreset({
    targetId: "medicspro-agent",
    deviceId,
    environment: "production",
    preset: "operator-workspace",
  }),
  allowedDockerActions: ["restart"],
};
const invalid = validateAgentTargetAgainstPreset(widened, "operator-workspace");
assert.equal(invalid.valid, false);
assert.deepEqual(invalid.differences, ["allowedDockerActions"]);

console.log("MULTI_VPS_CAPABILITY_BASELINE_V1=GREEN");
