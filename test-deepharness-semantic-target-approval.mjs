#!/usr/bin/env node
/** Offline CI only. Checks official target prepare -> human confirm -> apply. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dsh-target-approval-"));
process.env.STATE_FILE=path.join(dir,"state.json");
process.env.AUDIT_FILE=path.join(dir,"audit.jsonl");
process.env.TARGETS_FILE=path.join(dir,"targets.json");
process.env.AUTH_MODE="oauth";
process.env.AUTH_SECRET="dsh-target-approval-test-secret".padEnd(64,"x");
fs.writeFileSync(process.env.TARGETS_FILE,JSON.stringify({targets:[{
  id:"original-read-only",transport:"mock",environment:"production",
  capabilityProfile:"read-only",enabled:true,
}]}));
try{
  const state=await import("./dist/state/store.js");
  const targets=await import("./dist/config/targets.js");
  const approvals=await import("./dist/config/target-approvals.js");
  state.initStateStore();
  targets.loadRegistry();
  const pair=state.createPairing({hostname:"synthetic-28server",os:"CI"});
  assert.ok(state.approvePairingByCode(pair.code));
  const claimed=state.claimPairing(pair.pairing_id,pair.poll_token);
  assert.equal(claimed.status,"paired");
  const deviceId=claimed.device.device_id;
  const base={actor:"test-owner",targetId:"deepharness-semantic-lab",
    deviceId,environment:"development",preset:"deepharness-semantic-lab"};
  assert.throws(()=>approvals.prepareAgentTarget({...base,environment:"production"}),
    /development/);
  assert.throws(()=>approvals.prepareAgentTarget({...base,targetId:"deepharness-read"}),
    /target exato/);
  state.touchDeviceHeartbeat(deviceId,{agent_version:"test",capabilities:["host.status"]});
  assert.throws(()=>approvals.prepareAgentTarget(base),
    /não anunciou deepharness.semantic/);
  assert.equal(targets.getTarget(base.targetId),undefined);
  state.touchDeviceHeartbeat(deviceId,{agent_version:"test",
    capabilities:["host.status","deepharness.semantic"]});
  const request=approvals.prepareAgentTarget(base);
  assert.match(request.approval_id,/^adm_[a-f0-9]{24}$/);
  assert.equal(request.applied,false);
  assert.equal(request.target_id,base.targetId);
  assert.equal(request.capability_baseline.authority_class,"semantic-operator");
  assert.equal(request.capability_baseline.workspace_write_roots,0);
  assert.equal(targets.getTarget(base.targetId),undefined);
  state.touchDeviceHeartbeat(deviceId,{agent_version:"test",capabilities:["host.status"]});
  assert.throws(()=>approvals.applyAgentTargetApproval({actor:base.actor,
    approvalId:request.approval_id,confirmation:request.required_confirmation}),
    /deixou de anunciar deepharness.semantic/);
  assert.equal(targets.getTarget(base.targetId),undefined);
  state.touchDeviceHeartbeat(deviceId,{agent_version:"test",
    capabilities:["deepharness.semantic"]});
  assert.throws(()=>approvals.applyAgentTargetApproval({actor:"another-owner",
    approvalId:request.approval_id,confirmation:request.required_confirmation}),
    /outro ator/);
  assert.throws(()=>approvals.applyAgentTargetApproval({actor:base.actor,
    approvalId:request.approval_id,confirmation:"APPROVE incorrect"}),
    /confirmação inválida/);
  const applied=approvals.applyAgentTargetApproval({actor:base.actor,
    approvalId:request.approval_id,confirmation:request.required_confirmation});
  assert.equal(applied.applied,true);
  const target=targets.getTarget(base.targetId);
  assert.ok(target);
  assert.equal(target.environment,"development");
  assert.equal(target.transport,"agent");
  assert.equal(target.capabilityProfile,"semantic-operator");
  assert.deepEqual(target.allowedSemanticCapabilities,["deepharness.semantic"]);
  for(const key of ["allowedPaths","allowedGitRepos","allowedWritePaths",
    "allowedProcessCwds","allowedProcessPrograms","allowedServices",
    "allowedServiceActions","allowedDockerContainers","allowedDockerActions",
    "allowedDockerExecContainers","allowedAdminPrograms","allowedAdminCwds"]){
    assert.deepEqual(target[key],[],key);
  }
  assert.equal(targets.getTarget("original-read-only")?.capabilityProfile,"read-only");
  assert.equal(targets.getTarget("original-read-only")?.transport,"mock");
  console.log("DSH_LAB_TARGET_APPROVAL=GREEN");
}finally{
  fs.rmSync(dir,{recursive:true,force:true});
}
