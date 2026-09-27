#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"remote-ops-managed-admin-e2e-"));
const stateFile=path.join(tmp,"state.json");
const targetsFile=path.join(tmp,"targets.json");
const auditFile=path.join(tmp,"audit.jsonl");
const deviceState=path.join(tmp,"device.json");
const brokerSocket=path.join(tmp,"admin.sock");
const replayFile=path.join(tmp,"replay.json");
const publicKeyFile=path.join(tmp,"public.pem");

process.env.STATE_FILE=stateFile;
process.env.TARGETS_FILE=targetsFile;
process.env.AUDIT_FILE=auditFile;
process.env.AUTH_MODE="oauth";
process.env.AUTH_SECRET="managed-admin-e2e-secret-".padEnd(64,"x");
process.env.MCP_PASSWORD="managed-admin-e2e-mcp-password";
process.env.ADMIN_PASSWORD="managed-admin-e2e-admin-password";
process.env.WANDORA_ADMIN_BROKER_SOCKET=brokerSocket;

fs.writeFileSync(targetsFile,JSON.stringify({
  targets:[{
    id:"bootstrap",
    transport:"mock",
    environment:"development",
    capabilityProfile:"operator",
    enabled:true
  }]
},null,2));

let server;
let broker;
let agent;
try{
  const state=await import("./dist/state/store.js");
  const targets=await import("./dist/config/targets.js");
  const gateway=await import("./dist/agent/gateway.js");
  const ticket=await import("./dist/privileged/managed-admin-ticket.js");
  const {TOOL_DEFS}=await import("./dist/tools/index.js");

  state.initStateStore();
  targets.loadRegistry();

  const pairing=state.createPairing({hostname:"managed-admin-e2e",os:"Ubuntu test",agent_version:"test"});
  assert.ok(state.approvePairingByCode(pairing.code));
  const claimed=state.claimPairing(pairing.pairing_id,pairing.poll_token);
  assert.equal(claimed.status,"paired");
  if(claimed.status!=="paired")throw new Error("pairing failed");

  fs.writeFileSync(publicKeyFile,ticket.deriveManagedAdminPublicKeyPem(process.env.AUTH_SECRET));
  fs.writeFileSync(deviceState,JSON.stringify({
    control_plane:"http://127.0.0.1:0",
    device_id:claimed.device.device_id,
    device_token:claimed.device_token,
    paired_at:new Date().toISOString()
  }),{mode:0o600});

  broker=spawn(process.execPath,["dist/privileged/managed-admin-broker.js"],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      WANDORA_ADMIN_BROKER_SOCKET:brokerSocket,
      WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY:publicKeyFile,
      WANDORA_AGENT_STATE:deviceState,
      WANDORA_ADMIN_REPLAY_FILE:replayFile,
      WANDORA_ADMIN_CWDS:tmp,
      WANDORA_ADMIN_PROGRAMS:"df,cp",
    },
    stdio:["ignore","pipe","pipe"],
  });
  let brokerLogs="";
  broker.stdout.on("data",(d)=>brokerLogs+=d.toString());
  broker.stderr.on("data",(d)=>brokerLogs+=d.toString());
  for(let i=0;i<80&&!fs.existsSync(brokerSocket);i++)await new Promise(r=>setTimeout(r,50));
  if(!fs.existsSync(brokerSocket))throw new Error("managed admin broker did not start: "+brokerLogs);

  server=http.createServer((_req,res)=>res.end("ok"));
  gateway.attachAgentGateway(server);
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  const addr=server.address();
  if(!addr||typeof addr==="string")throw new Error("failed to allocate gateway port");
  const controlPlane="http://127.0.0.1:"+addr.port;
  fs.writeFileSync(deviceState,JSON.stringify({
    control_plane:controlPlane,
    device_id:claimed.device.device_id,
    device_token:claimed.device_token,
    paired_at:new Date().toISOString()
  }),{mode:0o600});

  agent=spawn(process.execPath,["dist/agent/cli.js","run"],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      WANDORA_CONTROL_PLANE:controlPlane,
      WANDORA_AGENT_STATE:deviceState,
      WANDORA_ADMIN_BROKER_SOCKET:brokerSocket,
    },
    stdio:["ignore","pipe","pipe"],
  });
  let agentLogs="";
  agent.stdout.on("data",(d)=>agentLogs+=d.toString());
  agent.stderr.on("data",(d)=>agentLogs+=d.toString());
  for(let i=0;i<100&&!agentLogs.includes("AGENT_CHANNEL=WELCOME");i++)await new Promise(r=>setTimeout(r,50));
  if(!agentLogs.includes("AGENT_CHANNEL=WELCOME"))throw new Error("agent did not connect: "+agentLogs);

  for(let i=0;i<80;i++){
    const d=state.listDevices().find((x)=>x.device_id===claimed.device.device_id);
    if(d?.capabilities?.includes("host.managed_admin"))break;
    await new Promise(r=>setTimeout(r,50));
  }
  const liveDevice=state.listDevices().find((x)=>x.device_id===claimed.device.device_id);
  assert.equal(liveDevice?.capabilities?.includes("host.managed_admin"),true);

  const tool=(name)=>{
    const x=TOOL_DEFS.find((d)=>d.name===name);
    if(!x)throw new Error("missing tool "+name);
    return x;
  };
  const ctx={actor:"e2e-actor",requestId:"e2e-request"};

  const targetPrepared=await tool("target_agent_prepare").run({
    target_id:"managed-admin-e2e",
    device_id:claimed.device.device_id,
    environment:"development",
    preset:"managed-admin",
  },ctx);
  const targetApproval=String(targetPrepared.approval_id);
  await tool("target_agent_apply").run({
    approval_id:targetApproval,
    confirmation:"APPROVE "+targetApproval,
  },ctx);

  const t=targets.getTarget("managed-admin-e2e");
  assert.ok(t);
  t.allowedAdminCwds=[tmp];
  t.allowedAdminPrograms=["df","cp"];

  const prepared=await tool("host_admin_prepare").run({
    target:"managed-admin-e2e",
    program:"df",
    args:["-h",tmp],
    cwd:tmp,
    timeout_ms:5000,
  },ctx);
  const approvalId=String(prepared.approval_id);
  const applied=await tool("host_admin_apply").run({
    target:"managed-admin-e2e",
    approval_id:approvalId,
    confirmation:"APPROVE "+approvalId,
  },ctx);
  assert.equal(applied.executed,true);
  assert.equal(applied.target,"managed-admin-e2e");
  assert.equal(applied.result.exit_code,0);
  assert.equal(typeof applied.result.stdout,"string");
  assert.ok(applied.result.stdout.length>0);

  const failPrepared=await tool("host_admin_prepare").run({
    target:"managed-admin-e2e",
    program:"cp",
    args:[path.join(tmp,"missing-source"),path.join(tmp,"dest")],
    cwd:tmp,
    timeout_ms:5000,
  },ctx);
  const failId=String(failPrepared.approval_id);
  await assert.rejects(
    ()=>tool("host_admin_apply").run({
      target:"managed-admin-e2e",
      approval_id:failId,
      confirmation:"APPROVE "+failId,
    },ctx),
    /managed-admin falhou/
  );

  console.log("MANAGED_ADMIN_CONTROL_PLANE_E2E=GREEN");
}finally{
  if(agent&&!agent.killed)agent.kill("SIGTERM");
  if(broker&&!broker.killed)broker.kill("SIGTERM");
  if(server)await new Promise(r=>server.close(()=>r()));
  fs.rmSync(tmp,{recursive:true,force:true});
}
