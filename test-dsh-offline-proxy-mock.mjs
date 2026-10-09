import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { REQUIRED_CHECKS } from "./dist/docker/vigiafast-offline-probe.js";

const dirname=fs.mkdtempSync(path.join(os.tmpdir(),"vigiafast-lab-proxy-"));
const dockerSocket=path.join(dirname,"docker.sock");
const seen=[];
let conflict=false;
const id="a".repeat(64);
const digest="sha256:"+"b".repeat(64);
const checks=Object.fromEntries(REQUIRED_CHECKS.map(k=>[k,true]));
const att=JSON.stringify({type:"offline_lab_attestation",ok:true,checks,rogue:"SHOULD_NOT_ESCAPE"})+"\n";
const frame=Buffer.alloc(8+Buffer.byteLength(att));
frame[0]=1;
frame.writeUInt32BE(Buffer.byteLength(att),4);
frame.write(att,8);
const daemon=http.createServer(async(req,res)=>{
  const body=[];
  for await(const b of req)body.push(Buffer.from(b));
  seen.push({method:req.method,path:req.url,body:Buffer.concat(body).toString("utf8")});
  if(req.url?.startsWith("/containers/create?name=")){
    res.writeHead(conflict?409:201,{"content-type":"application/json"});
    res.end(JSON.stringify(conflict?{message:"already exists"}:{Id:id}));
  } else if(req.url?.endsWith("/start")){
    res.writeHead(204);res.end();
  } else if(req.url?.includes("/wait?condition=not-running")){
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({StatusCode:0}));
  } else if(req.url?.includes("/logs?")){
    res.writeHead(200,{"content-type":"application/octet-stream"});res.end(frame);
  } else if(req.method==="DELETE"&&req.url?.startsWith("/containers/")){
    res.writeHead(204);res.end();
  } else {
    res.writeHead(404);res.end();
  }
});
await new Promise(resolve=>daemon.listen(dockerSocket,resolve));
const bind=net.createServer();
await new Promise(resolve=>bind.listen(0,"127.0.0.1",resolve));
const port=bind.address().port;
await new Promise(resolve=>bind.close(resolve));
const child=spawn(process.execPath,["dist/docker/read-proxy.js"],{
  env:{...process.env,DOCKER_SOCKET_PATH:dockerSocket,PORT:String(port),
    BIND_HOST:"127.0.0.1",ALLOWED_DOCKER_CONTAINERS:"unused",VIGIAFAST_DSH_OFFLINE_IMAGE_SHA256:digest},
  stdio:["ignore","ignore","pipe"]
});
let stderr="";
child.stderr.on("data",c=>{stderr+=c.toString().slice(0,2000);});
const endpoint="http://127.0.0.1:"+port+"/ops/vigiafast/dsh/offline-probe";
const request=async(data)=>fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)});
try{
  let ready=false;
  for(let i=0;i<50;i++){
    try{const response=await fetch("http://127.0.0.1:"+port+"/healthz");if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.equal(ready,true,"proxy did not start: "+stderr.slice(0,300));
  const deny=await request({model:"arbitrary",network:"host",command:"sh"});
  assert.equal(deny.status,400);
  assert.equal(seen.length,0,"invalid payload must not call Docker daemon");

  const success=await request({});
  assert.equal(success.status,200);
  const result=await success.json();
  assert.equal(result.type,"offline_lab_attestation");
  assert.equal(result.ok,true);
  assert.equal(result.checks.no_provider_material,true);
  assert.equal(Object.hasOwn(result.checks,"no_provider_secret"),false);
  assert.equal(Object.hasOwn(result,"rogue"),false);
  assert.equal(seen.length,5,"only create/start/wait/logs/delete are permitted");
  assert.ok(seen[0].path?.startsWith("/containers/create?name=vigiafast-dsh-offline-probe"));
  const create=JSON.parse(seen[0].body);
  assert.equal(create.Image,digest);
  assert.equal(create.HostConfig.NetworkMode,"none");
  assert.equal(create.NetworkDisabled,true);
  assert.equal(create.HostConfig.ReadonlyRootfs,true);
  assert.deepEqual(create.HostConfig.Binds,[]);
  assert.deepEqual(create.HostConfig.PortBindings,{});
  assert.equal(seen.at(-1).method,"DELETE");

  conflict=true;
  const old=seen.length;
  const refused=await request({});
  assert.equal(refused.status,502);
  assert.deepEqual(seen.slice(old).map(x=>x.method),["POST"],
    "creation conflict must not delete a preexisting container");
  console.log("VIGIAFAST_DSH_PROXY_MOCK=GREEN (deny, pinned create, sanitize, cleanup, conflict)");
}finally{
  child.kill("SIGTERM");
  await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once("close",resolve);});
  await new Promise(resolve=>daemon.close(resolve));
  fs.rmSync(dirname,{recursive:true,force:true});
}
