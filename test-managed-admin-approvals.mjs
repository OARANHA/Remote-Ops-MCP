#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"remote-ops-managed-admin-approval-"));
process.env.STATE_FILE=path.join(tmp,"state.json");
process.env.AUDIT_FILE=path.join(tmp,"audit.jsonl");
process.env.TARGETS_FILE=path.join(tmp,"targets.json");
process.env.AUTH_MODE="oauth";
process.env.AUTH_SECRET="managed-admin-approval-secret-".padEnd(64,"x");

fs.writeFileSync(process.env.TARGETS_FILE,JSON.stringify({
  targets:[{
    id:"wandora-agent",
    transport:"mock",
    environment:"production",
    capabilityProfile:"operator",
    enabled:true
  }]
},null,2));

try{
  const state=await import("./dist/state/store.js");
  const targetRegistry=await import("./dist/config/targets.js");
  const targetApprovals=await import("./dist/config/target-approvals.js");
  const managed=await import("./dist/config/managed-admin-approvals.js");
  const ticket=await import("./dist/privileged/managed-admin-ticket.js");

  state.initStateStore();
  targetRegistry.loadRegistry();

  const pairing=state.createPairing({hostname:"managed-admin-host",os:"Ubuntu test",agent_version:"test"});
  assert.ok(state.approvePairingByCode(pairing.code));
  const claimed=state.claimPairing(pairing.pairing_id,pairing.poll_token);
  assert.equal(claimed.status,"paired");
  if(claimed.status!=="paired")throw new Error("pairing failed");
  const deviceId=claimed.device.device_id;
  assert.equal(state.touchDeviceHeartbeat(deviceId,{
    agent_version:"test",
    capabilities:["host.managed_admin"]
  }),true);

  const preparedTarget=targetApprovals.prepareAgentTarget({
    actor:"test-actor",
    targetId:"managed-admin-host",
    deviceId,
    environment:"production",
    preset:"managed-admin",
  });
  targetApprovals.applyAgentTargetApproval({
    actor:"test-actor",
    approvalId:preparedTarget.approval_id,
    confirmation:`APPROVE ${preparedTarget.approval_id}`,
  });

  const t=targetRegistry.getTarget("managed-admin-host");
  assert.ok(t);
  assert.deepEqual(t.allowedSemanticCapabilities,["host.managed_admin"]);
  assert.equal(t.allowedAdminPrograms.includes("docker"),true);
  assert.equal(t.allowedAdminPrograms.includes("bash"),false);

  assert.throws(
    ()=>managed.prepareManagedAdminAction({
      actor:"test-actor",
      targetId:"managed-admin-host",
      program:"bash",
      argv:["-lc","id"],
      cwd:"/opt/wandora",
    }),
    /hard-denied/
  );

  assert.throws(
    ()=>managed.prepareManagedAdminAction({
      actor:"test-actor",
      targetId:"managed-admin-host",
      program:"docker",
      argv:["ps"],
      cwd:"/etc",
    }),
    /fora da allowlist/
  );

  const prepared=managed.prepareManagedAdminAction({
    actor:"test-actor",
    targetId:"managed-admin-host",
    program:"docker",
    argv:["compose","ps"],
    cwd:"/opt/wandora",
    timeoutMs:45_000,
  });
  assert.match(prepared.approval_id,/^adm_[a-f0-9]{24}$/);
  assert.equal(prepared.executed,false);
  assert.deepEqual(prepared.argv_preview,["compose","ps"]);

  assert.throws(
    ()=>managed.consumeManagedAdminApproval({
      actor:"test-actor",
      targetId:"other-target",
      approvalId:prepared.approval_id,
      confirmation:`APPROVE ${prepared.approval_id}`,
    }),
    /target informado/
  );

  assert.throws(
    ()=>managed.consumeManagedAdminApproval({
      actor:"other-actor",
      targetId:"managed-admin-host",
      approvalId:prepared.approval_id,
      confirmation:`APPROVE ${prepared.approval_id}`,
    }),
    /outro ator/
  );

  assert.throws(
    ()=>managed.consumeManagedAdminApproval({
      actor:"test-actor",
      targetId:"managed-admin-host",
      approvalId:prepared.approval_id,
      confirmation:"APPROVE wrong",
    }),
    /confirmação inválida/
  );

  const consumed=managed.consumeManagedAdminApproval({
    actor:"test-actor",
    targetId:"managed-admin-host",
    approvalId:prepared.approval_id,
    confirmation:`APPROVE ${prepared.approval_id}`,
  });
  assert.equal(consumed.ticket.target_id,"managed-admin-host");
  assert.equal(consumed.ticket.device_id,deviceId);
  assert.equal(consumed.ticket.program,"docker");
  assert.deepEqual(consumed.ticket.argv,["compose","ps"]);
  assert.equal(consumed.ticket.cwd,"/opt/wandora");
  assert.ok(consumed.ticket.expires_at-consumed.ticket.issued_at<=120_000);
  const pub=ticket.deriveManagedAdminPublicKeyPem(process.env.AUTH_SECRET);
  assert.equal(ticket.verifyManagedAdminTicket(consumed.ticket,consumed.signature,pub),true);

  assert.throws(
    ()=>managed.consumeManagedAdminApproval({
      actor:"test-actor",
      targetId:"managed-admin-host",
      approvalId:prepared.approval_id,
      confirmation:`APPROVE ${prepared.approval_id}`,
    }),
    /inexistente ou expirada/
  );

  console.log("MANAGED_ADMIN_APPROVALS=GREEN");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
