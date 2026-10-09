#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  buildAgentTargetFromPreset,
  validateAgentTargetAgainstPreset,
} = await import("./dist/config/capability-baseline.js");
const { LAB_TARGET_ID, LAB_CAPABILITY } = await import("./dist/docker/vigiafast-offline-probe.js");
const preset="vigiafast-dsh-offline";
const deviceId="dev_test_vigiafast_lab0001";

const target=buildAgentTargetFromPreset({
  targetId:LAB_TARGET_ID, deviceId, environment:"development", preset,
});
assert.equal(target.id,LAB_TARGET_ID);
assert.equal(target.environment,"development");
assert.equal(target.capabilityProfile,"operator");
assert.equal(target.transport,"agent");
assert.deepEqual(target.allowedSemanticCapabilities,[LAB_CAPABILITY]);
for(const key of [
  "allowedPaths","allowedWritePaths","allowedProcessCwds","allowedProcessPrograms",
  "allowedDockerContainers","allowedDockerActions","allowedDockerImageLoadRoots",
  "allowedDockerExecContainers","allowedDockerExecPrograms","allowedServices",
  "allowedServiceActions","allowedAdminPrograms","allowedAdminCwds","allowedGitRepos",
]) assert.deepEqual(target[key],[],key+" must be empty");
assert.equal(validateAgentTargetAgainstPreset(target,preset).valid,true);

for(const bad of [
  {targetId:"wandora-agent",deviceId,environment:"development",preset},
  {targetId:LAB_TARGET_ID,deviceId,environment:"production",preset},
  {targetId:LAB_TARGET_ID,deviceId,environment:"staging",preset},
])assert.throws(()=>buildAgentTargetFromPreset(bad),/vigiafast_lab_target_requires_exact_id_and_development/);

const widened={...target,allowedProcessPrograms:["node"]};
assert.equal(validateAgentTargetAgainstPreset(widened,preset).valid,false);
assert.deepEqual(validateAgentTargetAgainstPreset(widened,preset).differences,["allowedProcessPrograms"]);

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vigiafast-lab-target-"));
process.env.STATE_FILE=path.join(tmp,"state.json");
process.env.AUDIT_FILE=path.join(tmp,"audit.jsonl");
process.env.TARGETS_FILE=path.join(tmp,"targets.json");
process.env.AUTH_MODE="oauth";
process.env.AUTH_SECRET="test-private-auth-secret-".padEnd(64,"x");

try {
  fs.writeFileSync(process.env.TARGETS_FILE,JSON.stringify({targets:[{
    id:"wandora-agent",transport:"mock",environment:"production",capabilityProfile:"operator",enabled:true,
  }]}));
  const state=await import("./dist/state/store.js");
  const targets=await import("./dist/config/targets.js");
  const approvals=await import("./dist/config/target-approvals.js");
  state.initStateStore();
  targets.loadRegistry();

  function newDevice(hostname) {
    const pairing=state.createPairing({hostname,os:"linux test",agent_version:"test"});
    assert.equal(state.approvePairingByCode(pairing.code),true);
    const claimed=state.claimPairing(pairing.pairing_id,pairing.poll_token);
    assert.equal(claimed.status,"paired");
    const id=claimed.device.device_id;
    assert.equal(state.touchDeviceHeartbeat(id,{agent_version:"test",capabilities:["host","workspace"]}),true);
    return id;
  }
  const labDevice=newDevice("isolated-lab-test");
  const sharedDevice=newDevice("other-target-test");

  for(const bad of [
    {targetId:"wrong-lab",deviceId:labDevice,environment:"development"},
    {targetId:LAB_TARGET_ID,deviceId:labDevice,environment:"production"},
    {targetId:LAB_TARGET_ID,deviceId:labDevice,environment:"staging"},
  ])assert.throws(()=>approvals.prepareAgentTarget({actor:"tester",...bad,preset}),/laboratorio exige target exato de desenvolvimento/);
  assert.equal(targets.getTarget(LAB_TARGET_ID),undefined);

  const p=approvals.prepareAgentTarget({actor:"tester",targetId:LAB_TARGET_ID,deviceId:labDevice,environment:"development",preset});
  assert.match(p.approval_id,/^adm_[a-f0-9]{24}$/);
  assert.equal(p.capability_baseline.process_programs,0);
  assert.equal(p.capability_baseline.semantic_capabilities,1);
  assert.equal(targets.getTarget(LAB_TARGET_ID),undefined,"prepare must not mutate the registry");
  assert.throws(()=>approvals.applyAgentTargetApproval({actor:"tester",approvalId:p.approval_id,confirmation:"APPROVE invalid"}),/confirmação inválida/);
  const applied=approvals.applyAgentTargetApproval({actor:"tester",approvalId:p.approval_id,confirmation:"APPROVE "+p.approval_id});
  assert.equal(applied.applied,true);
  assert.deepEqual(targets.getTarget(LAB_TARGET_ID).allowedSemanticCapabilities,[LAB_CAPABILITY]);
  assert.deepEqual(targets.getTarget(LAB_TARGET_ID).allowedProcessPrograms,[]);
  assert.deepEqual(targets.getTarget(LAB_TARGET_ID).allowedWritePaths,[]);

  const other=approvals.prepareAgentTarget({actor:"tester",targetId:"other-service",deviceId:sharedDevice,environment:"development",preset:"read-only"});
  approvals.applyAgentTargetApproval({actor:"tester",approvalId:other.approval_id,confirmation:"APPROVE "+other.approval_id});
  assert.throws(()=>approvals.prepareAgentTarget({actor:"tester",targetId:LAB_TARGET_ID,deviceId:sharedDevice,environment:"development",preset}),/device Agent Mesh exclusivo/);

  // A device may be shared AFTER the lab approval was prepared; apply must re-check.
  const pending=approvals.prepareAgentTarget({actor:"tester",targetId:LAB_TARGET_ID,deviceId:labDevice,environment:"development",preset});
  const competitor=approvals.prepareAgentTarget({actor:"tester",targetId:"competing",deviceId:labDevice,environment:"development",preset:"read-only"});
  approvals.applyAgentTargetApproval({actor:"tester",approvalId:competitor.approval_id,confirmation:"APPROVE "+competitor.approval_id});
  assert.throws(()=>approvals.applyAgentTargetApproval({actor:"tester",approvalId:pending.approval_id,confirmation:"APPROVE "+pending.approval_id}),/device do laboratorio nao e exclusivo/);
  assert.equal(targets.getTarget(LAB_TARGET_ID).deviceId,labDevice,"existing lab unchanged");
  console.log("VIGIAFAST_DSH_TARGET_PRESET=GREEN (minimal authority, development only, exact ID, exclusive device, signed approval gate)");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
