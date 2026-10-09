import assert from "node:assert/strict";
import fs from "node:fs";
import { isOfflineLabDeviceMode } from "./dist/agent/offline-lab-device.js";
import { LAB_CAPABILITY } from "./dist/docker/vigiafast-offline-probe.js";
import { executeAgentOperation } from "./dist/agent/operations.js";

const valid={VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"1",DOCKER_HOST:"tcp://127.0.0.1:23751"};
assert.equal(isOfflineLabDeviceMode(valid),true);
for(const cfg of [
  {},
  {VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"1"},
  {VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"true",DOCKER_HOST:valid.DOCKER_HOST},
  {VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"0",DOCKER_HOST:valid.DOCKER_HOST},
  {VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"1",DOCKER_HOST:"tcp://127.0.0.1:23752"},
  {VIGIAFAST_DSH_OFFLINE_DEVICE_MODE:"1",DOCKER_HOST:"unix:///var/run/docker.sock"},
]) assert.equal(isOfflineLabDeviceMode(cfg),false,"unexpected mode activation");

const beforeMode=process.env.VIGIAFAST_DSH_OFFLINE_DEVICE_MODE;
const beforeHost=process.env.DOCKER_HOST;
try{
  delete process.env.VIGIAFAST_DSH_OFFLINE_DEVICE_MODE;
  process.env.DOCKER_HOST=valid.DOCKER_HOST;
  await assert.rejects(
    ()=>executeAgentOperation({op:LAB_CAPABILITY,args:{}}),
    /offline_lab_device_not_enabled/
  );
  process.env.VIGIAFAST_DSH_OFFLINE_DEVICE_MODE="1";
  for(const operation of [
    {op:"host.status"},
    {op:"process.start",args:{program:"node",cwd:"/opt/wandora/ops-workspace",argv:[]}},
    {op:"docker.candidate_run",args:{}},
    {op:"docker.exec",args:{}},
    {op:"host.managed_admin",args:{}},
    {op:"workspace.write",args:{}},
  ])await assert.rejects(()=>executeAgentOperation(operation),/offline_lab_device_only/,operation.op);
}finally{
  if(beforeMode===undefined)delete process.env.VIGIAFAST_DSH_OFFLINE_DEVICE_MODE;
  else process.env.VIGIAFAST_DSH_OFFLINE_DEVICE_MODE=beforeMode;
  if(beforeHost===undefined)delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST=beforeHost;
}

// The capability list advertised by an isolated lab device cannot
// inherit generic workspace, Docker, managed-admin or process authority.
const cli=fs.readFileSync("src/agent/cli.ts","utf8");
assert.match(cli,/if \(isOfflineLabDeviceMode\(\)\) return \[LAB_CAPABILITY\];/);
console.log("VIGIAFAST_DSH_LAB_AGENT_MODE=GREEN (explicit opt-in, default deny, lab-only operation allowlist)");
