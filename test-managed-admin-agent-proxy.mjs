#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"remote-ops-managed-admin-agent-"));
const socket=path.join(tmp,"admin.sock");
const state=path.join(tmp,"device.json");
const replay=path.join(tmp,"replay.json");
const pub=path.join(tmp,"public.pem");
const secret="managed-admin-agent-test-secret-".padEnd(64,"x");
const deviceId="dev_TESTDEVICE1234";

process.env.WANDORA_ADMIN_BROKER_SOCKET=socket;

try{
  const ticketMod=await import("./dist/privileged/managed-admin-ticket.js");
  fs.writeFileSync(state,JSON.stringify({device_id:deviceId}));
  fs.writeFileSync(pub,ticketMod.deriveManagedAdminPublicKeyPem(secret));

  const broker=spawn(process.execPath,["dist/privileged/managed-admin-broker.js"],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      WANDORA_ADMIN_BROKER_SOCKET:socket,
      WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY:pub,
      WANDORA_AGENT_STATE:state,
      WANDORA_ADMIN_REPLAY_FILE:replay,
      WANDORA_ADMIN_CWDS:tmp,
      WANDORA_ADMIN_PROGRAMS:"printf",
    },
    stdio:["ignore","pipe","pipe"],
  });
  let logs="";
  broker.stdout.on("data",(d)=>logs+=d.toString());
  broker.stderr.on("data",(d)=>logs+=d.toString());

  for(let i=0;i<80&&!fs.existsSync(socket);i++)await new Promise(r=>setTimeout(r,50));
  if(!fs.existsSync(socket))throw new Error("broker did not start: "+logs);

  const ops=await import("./dist/agent/operations.js");
  const now=Date.now();
  const ticket={
    v:1,
    target_id:"managed-admin-test",
    device_id:deviceId,
    program:"printf",
    argv:["hello-agent-forward"],
    cwd:tmp,
    timeout_ms:5000,
    nonce:crypto.randomBytes(24).toString("hex"),
    issued_at:now,
    expires_at:now+60_000,
  };
  const signature=ticketMod.signManagedAdminTicket(ticket,secret);
  const ok=await ops.executeAgentOperation({
    op:"host.managed_admin",
    args:{ticket,signature},
  },{timeoutMs:7000});
  assert.equal(ok.code,0,ok.stderr);
  const result=JSON.parse(ok.stdout);
  assert.equal(result.exit_code,0);
  assert.equal(result.stdout,"hello-agent-forward");

  const badTicket={...ticket,nonce:crypto.randomBytes(24).toString("hex"),argv:["tampered"]};
  const bad=await ops.executeAgentOperation({
    op:"host.managed_admin",
    args:{ticket:badTicket,signature},
  },{timeoutMs:7000});
  assert.equal(bad.code,1);
  assert.match(bad.stderr,/INVALID_SIGNATURE/);

  broker.kill("SIGTERM");
  await new Promise(r=>broker.once("exit",r));
  console.log("MANAGED_ADMIN_AGENT_PROXY=GREEN");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
