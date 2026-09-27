import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const mod=await import("./dist/privileged/managed-admin-ticket.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"romcp-managed-admin-"));
const socket=path.join(tmp,"admin.sock");
const state=path.join(tmp,"device.json");
const replay=path.join(tmp,"replay.json");
const pub=path.join(tmp,"public.pem");
const secret="managed-admin-test-secret-".padEnd(64,"x");
const deviceId="dev_TESTDEVICE1234";
fs.writeFileSync(state,JSON.stringify({device_id:deviceId}));
fs.writeFileSync(pub,mod.deriveManagedAdminPublicKeyPem(secret));
const child=spawn(process.execPath,["dist/privileged/managed-admin-broker.js"],{
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
child.stdout.on("data",(d)=>logs+=d.toString());
child.stderr.on("data",(d)=>logs+=d.toString());
for(let i=0;i<80&&!fs.existsSync(socket);i++) await new Promise(r=>setTimeout(r,50));
if(!fs.existsSync(socket)) throw new Error("broker did not start: "+logs);

function request(body){
  return new Promise((resolve,reject)=>{
    const s=net.createConnection({path:socket});
    let data="";
    s.setEncoding("utf8");
    s.on("connect",()=>s.write(JSON.stringify(body)+"\n"));
    s.on("data",(chunk)=>{data+=chunk;const nl=data.indexOf("\n");if(nl>=0){try{resolve(JSON.parse(data.slice(0,nl)));}catch(e){reject(e);}finally{s.destroy();}}});
    s.on("error",reject);
  });
}
function ticket(overrides={}){
  const now=Date.now();
  return {
    v:1,
    target_id:"managed-admin-test",
    device_id:deviceId,
    program:"printf",
    argv:["hello-managed-admin"],
    cwd:tmp,
    timeout_ms:5000,
    nonce:crypto.randomBytes(24).toString("hex"),
    issued_at:now,
    expires_at:now+60_000,
    ...overrides,
  };
}
function signed(t){return {ticket:t,signature:mod.signManagedAdminTicket(t,secret)};}

const good=ticket();
const ok=await request(signed(good));
assert.equal(ok.ok,true,JSON.stringify(ok));
assert.equal(ok.result.code,0);
assert.equal(ok.result.stdout,"hello-managed-admin");

const replayed=await request(signed(good));
assert.equal(replayed.ok,false);
assert.equal(replayed.error.code,"REPLAY_DENIED");

const tamperBase=ticket();
const tampered=await request({ticket:{...tamperBase,argv:["tampered"]},signature:mod.signManagedAdminTicket(tamperBase,secret)});
assert.equal(tampered.ok,false);
assert.equal(tampered.error.code,"INVALID_SIGNATURE");

const wrong=ticket({device_id:"dev_WRONGDEVICE999"});
const wrongRes=await request(signed(wrong));
assert.equal(wrongRes.ok,false);
assert.equal(wrongRes.error.code,"CAPABILITY_DENIED");

const denied=ticket({program:"echo"});
const deniedRes=await request(signed(denied));
assert.equal(deniedRes.ok,false);
assert.equal(deniedRes.error.code,"CAPABILITY_DENIED");

const now=Date.now();
const expired=ticket({issued_at:now-90_000,expires_at:now-30_000});
const expiredRes=await request(signed(expired));
assert.equal(expiredRes.ok,false);
assert.equal(expiredRes.error.code,"CAPABILITY_DENIED");

process.env.WANDORA_ADMIN_BROKER_SOCKET=socket;
const operations=await import("./dist/agent/operations.js");
const forwardedTicket=ticket({argv:["via-agent-mesh"]});
const forwarded=await operations.executeAgentOperation({
  op:"host.managed_admin",
  args:signed(forwardedTicket),
},{timeoutMs:5000});
assert.equal(forwarded.code,0,forwarded.stderr);
const forwardedResult=JSON.parse(forwarded.stdout);
assert.equal(forwardedResult.exit_code,0);
assert.equal(forwardedResult.stdout,"via-agent-mesh");
assert.equal(forwardedResult.program,"printf");

child.kill("SIGTERM");
await new Promise(r=>child.once("exit",r));
fs.rmSync(tmp,{recursive:true,force:true});
console.log("MANAGED_ADMIN_BROKER=GREEN");
