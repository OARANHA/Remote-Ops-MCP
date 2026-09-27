import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { executeAgentOperation } from "./dist/agent/operations.js";
import { postgresVerifierSha256 } from "./dist/docker/postgres-readback.js";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"remote-ops-postgres-proxy-"));
const socketPath=path.join(tmp,"docker.sock");
const sql="\\set ON_ERROR_STOP on\n\\pset pager off\nDO $ BEGIN IF to_regclass('public.contacts') IS NULL THEN RAISE EXCEPTION 'missing'; END IF; END $;\nSELECT 'VERIFY OK' AS result;";
const sha=postgresVerifierSha256(sql);
const execId="a".repeat(64);
const seen=[];

function dockerStream(text){
  const payload=Buffer.from(text,"utf8");
  const header=Buffer.alloc(8);
  header[0]=1;
  header.writeUInt32BE(payload.length,4);
  return Buffer.concat([header,payload]);
}

const docker=http.createServer(async(req,res)=>{
  const chunks=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
  const body=Buffer.concat(chunks).toString("utf8");
  seen.push({method:req.method,path:req.url,body});

  if(req.method==="POST"&&req.url==="/containers/supabase-db/exec"){
    res.writeHead(201,{"content-type":"application/json"});
    res.end(JSON.stringify({Id:execId}));
    return;
  }
  if(req.method==="POST"&&req.url===`/exec/${execId}/start`){
    const out=dockerStream("VERIFY OK\n");
    res.writeHead(200,{"content-type":"application/vnd.docker.raw-stream","content-length":out.length});
    res.end(out);
    return;
  }
  if(req.method==="GET"&&req.url===`/exec/${execId}/json`){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({ExitCode:0}));
    return;
  }
  res.writeHead(404,{"content-type":"application/json"});
  res.end(JSON.stringify({message:"unexpected fake Docker route"}));
});
await new Promise((resolve,reject)=>{
  docker.once("error",reject);
  docker.listen(socketPath,resolve);
});

const proxyEnv={
  ...process.env,
  PORT:"23751",
  BIND_HOST:"127.0.0.1",
  DOCKER_SOCKET_PATH:socketPath,
  ALLOWED_DOCKER_CONTAINERS:"supabase-db",
  POSTGRES_READBACK_CONTAINER:"supabase-db",
  POSTGRES_READBACK_VERIFIERS:`commercial-crm-core=${sha}`,
  POSTGRES_READBACK_EXEC_USER:"postgres",
  POSTGRES_READBACK_DB_USER:"postgres",
  POSTGRES_READBACK_DB_NAME:"postgres",
};
const proxy=spawn(process.execPath,["dist/docker/read-proxy.js"],{env:proxyEnv,stdio:["ignore","pipe","pipe"]});
let proxyStdout="",proxyStderr="";
proxy.stdout.on("data",(c)=>proxyStdout+=c.toString());
proxy.stderr.on("data",(c)=>proxyStderr+=c.toString());

async function health(){
  return await new Promise((resolve,reject)=>{
    const req=http.get({host:"127.0.0.1",port:23751,path:"/healthz"},(res)=>{
      let data="";res.on("data",(c)=>data+=c.toString());res.on("end",()=>resolve({status:res.statusCode,body:data}));
    });
    req.on("error",reject);
  });
}

try{
  let h=null;
  for(let i=0;i<60;i++){
    if(proxy.exitCode!==null) throw new Error("proxy exited early: "+proxyStderr);
    try{h=await health();break;}catch{}
    await new Promise((r)=>setTimeout(r,50));
  }
  assert.ok(h,"proxy health endpoint did not start");
  assert.equal(h.status,200);
  const hb=JSON.parse(h.body);
  assert.equal(hb.postgres_readback_configured,true);
  assert.deepEqual(hb.postgres_verifiers,["commercial-crm-core"]);
  assert.equal(h.body.includes(sha),false,"health must not expose approved verifier hashes");

  process.env.DOCKER_HOST="tcp://127.0.0.1:23751";
  const result=await executeAgentOperation({
    op:"postgres.pinned_readback",
    args:{verifierId:"commercial-crm-core",sql},
  },{timeoutMs:3000});
  assert.equal(result.code,0,result.stderr);
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.verifier_id,"commercial-crm-core");
  assert.equal(parsed.sha256,sha);
  assert.equal(parsed.output.includes("VERIFY OK"),true);

  assert.equal(seen.length,3);
  assert.equal(seen[0].path,"/containers/supabase-db/exec");
  const create=JSON.parse(seen[0].body);
  assert.equal(create.User,"postgres");
  assert.equal(create.AttachStdin,false);
  assert.equal(create.Cmd[0],"psql");
  assert.equal(create.Cmd.includes("bash"),false);
  assert.equal(create.Cmd.includes("sh"),false);
  assert.equal(create.Cmd.join(" ").includes("BEGIN TRANSACTION READ ONLY"),true);
  assert.equal(create.Cmd.join(" ").includes("ROLLBACK"),true);
  assert.equal(create.Cmd.join(" ").includes("\\set ON_ERROR_STOP on"),false);
  assert.equal(create.Cmd.join(" ").includes("\\pset pager off"),false);
  assert.equal(create.Env.some((x)=>x.includes("default_transaction_read_only=on")),true);
  assert.equal(create.Env.some((x)=>/password/i.test(x)),false);

  const beforeMismatch=seen.length;
  const mismatch=await executeAgentOperation({
    op:"postgres.pinned_readback",
    args:{verifierId:"commercial-crm-core",sql:sql+"\nSELECT 2;"},
  },{timeoutMs:3000});
  assert.equal(mismatch.code,1);
  assert.match(mismatch.stderr,/postgres_verifier_hash_mismatch/);
  assert.equal(seen.length,beforeMismatch,"hash mismatch must fail before Docker API access");

  const unknown=await executeAgentOperation({
    op:"postgres.pinned_readback",
    args:{verifierId:"not-approved",sql},
  },{timeoutMs:3000});
  assert.equal(unknown.code,1);
  assert.match(unknown.stderr,/postgres_verifier_not_allowed/);
  assert.equal(seen.length,beforeMismatch,"unknown verifier must fail before Docker API access");

  process.env.DOCKER_HOST="tcp://10.0.0.1:2375";
  await assert.rejects(
    ()=>executeAgentOperation({op:"postgres.pinned_readback",args:{verifierId:"commercial-crm-core",sql}},{timeoutMs:1000}),
    /docker_read_proxy_required/
  );

  console.log("POSTGRES_PINNED_PROXY_E2E=GREEN");
} finally {
  proxy.kill("SIGTERM");
  if(proxy.exitCode===null) await new Promise((resolve)=>proxy.once("exit",resolve));
  await new Promise((resolve)=>docker.close(resolve));
  fs.rmSync(tmp,{recursive:true,force:true});
}
