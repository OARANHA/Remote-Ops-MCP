#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepharness-docker-read-"));
process.env.STATE_FILE = path.join(tmp, "state.json");
process.env.AUDIT_FILE = path.join(tmp, "audit.jsonl");
process.env.TARGETS_FILE = path.join(tmp, "targets.json");
process.env.AUTH_MODE = "oauth";
process.env.AUTH_SECRET = "deepharness-approval-test-secret".padEnd(64, "x");

fs.writeFileSync(process.env.TARGETS_FILE, JSON.stringify({targets:[{
 id:"other-static", transport:"mock", environment:"production",
 capabilityProfile:"read-only", enabled:true,
}]}));

try {
 const state = await import("./dist/state/store.js");
 const targets = await import("./dist/config/targets.js");
 const agents = await import("./dist/config/target-approvals.js");
 const grant = await import("./dist/config/deepharness-read-approval.js");
 state.initStateStore();
 targets.loadRegistry();
 assert.throws(() => grant.prepareDeepharnessDockerRead("owner"), /unavailable/);
 const pairing=state.createPairing({hostname:"28server",os:"Ubuntu test",agent_version:"test"});
 state.approvePairingByCode(pairing.code);
 const claim=state.claimPairing(pairing.pairing_id,pairing.poll_token);
 assert.equal(claim.status,"paired");
 if(claim.status!=="paired") throw new Error("pairing denied");
 const deviceId=claim.device.device_id;
 state.touchDeviceHeartbeat(deviceId,{agent_version:"test",capabilities:["host","workspace"]});
 const p=agents.prepareAgentTarget({actor:"owner",targetId:"deepharness-read",
    deviceId,environment:"production",preset:"read-only"});
 agents.applyAgentTargetApproval({actor:"owner",approvalId:p.approval_id,confirmation:`APPROVE ${p.approval_id}`});
 const approval=grant.prepareDeepharnessDockerRead("owner");
 assert.deepEqual(targets.getTarget("deepharness-read")?.allowedDockerContainers,[]);
 assert.throws(()=>grant.applyDeepharnessDockerRead("another",approval.approval_id,`APPROVE ${approval.approval_id}`),/another actor/);
 assert.throws(()=>grant.applyDeepharnessDockerRead("owner",approval.approval_id,"APPROVE wrong"),/confirmação inválida/);
 const done=grant.applyDeepharnessDockerRead("owner",approval.approval_id,`APPROVE ${approval.approval_id}`);
 assert.equal(done.applied,true);
 const d=targets.getTarget("deepharness-read");
 assert.deepEqual(d?.allowedDockerContainers,["deepharness-web-1","deepharness-mcp-grants-db-1"]);
 assert.deepEqual(d?.allowedDockerExecContainers,[]);
 assert.deepEqual(d?.allowedDockerActions,[]);
 assert.deepEqual(d?.allowedAdminPrograms,[]);
 assert.deepEqual(d?.allowedWritePaths,[]);
 assert.deepEqual(targets.getTarget("other-static")?.allowedDockerContainers,[]);
 assert.throws(()=>grant.applyDeepharnessDockerRead("owner",approval.approval_id,`APPROVE ${approval.approval_id}`),/expired or missing/);
 console.log("DEEPHARNESS_READ_APPROVAL_GREEN");
} finally {
 fs.rmSync(tmp,{recursive:true,force:true});
}
