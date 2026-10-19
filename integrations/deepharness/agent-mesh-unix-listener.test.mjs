import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {mkdtemp,chmod,lstat,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startDshUnixRelayListener,DSH_RELAY_SOCKET} from "./agent-mesh-unix-listener.mjs";

async function isolatedDir(t){
  const dir=await mkdtemp(join(tmpdir(),"dsh-listener-gate-"));
  await chmod(dir,0o2710);
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
function post(socketPath){
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:"/wandora/dsh-bridge/v1",method:"POST",
      headers:{"content-type":"application/json","content-length":"2"}},res=>{
      const chunks=[];res.on("data",c=>chunks.push(c));
      res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });
    req.on("error",reject);
    req.end("{}");
  });
}
test("import creates no socket, runtime requires explicit opt-in and nonroot identity",async t=>{
  const dir=await isolatedDir(t), socketPath=join(dir,"bridge.sock");
  assert.equal(DSH_RELAY_SOCKET,"/run/wandora/deepharness-semantic/bridge.sock");
  await assert.rejects(startDshUnixRelayListener({handler:()=>{},socketPath}),/unavailable/);
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketPath,getUid:()=>0,socketGroupId:process.getgid()}),/unavailable/);
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketPath:join(dir,"bad.sock"),socketGroupId:process.getgid()}),/unavailable/);
  await assert.rejects(lstat(socketPath),e=>e.code==="ENOENT");
});
test("serves a fixed Unix socket with owner-only permissions and close",async t=>{
  const dir=await isolatedDir(t),socketPath=join(dir,"bridge.sock");
  const listener=await startDshUnixRelayListener({
    enabled:true,socketPath,socketGroupId:process.getgid(),
    handler:(_req,res)=>{
      res.writeHead(200,{"content-type":"application/json"});
      res.end('{"result":[]}');
    },
  });
  t.after(()=>listener.close());
  const s=await lstat(socketPath);
  assert.equal(s.isSocket(),true);
  assert.equal(s.mode&0o777,0o660);
  assert.equal(s.gid,process.getgid());
  assert.equal(s.uid,process.getuid());
  assert.equal(listener.server.address(),socketPath);
  assert.deepEqual(await post(socketPath),{status:200,body:'{"result":[]}'});
  assert.equal(listener.server.listening,true);
  await listener.close();
  await listener.close();
  assert.equal(listener.server.listening,false);
});
test("refuses a missing, untrusted or world-readable parent; never creates directory",async t=>{
  const dir=await isolatedDir(t),socketPath=join(dir,"bridge.sock");
  await chmod(dir,0o755);
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketPath,socketGroupId:process.getgid()}),/unavailable/);
  await chmod(dir,0o2710);
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketGroupId:process.getgid(),
    socketPath:join(dir,"missing","bridge.sock")}),/unavailable/);
  await assert.rejects(lstat(socketPath),e=>e.code==="ENOENT");
});
test("pre-existing file and active endpoint are never replaced",async t=>{
  const dir=await isolatedDir(t),socketPath=join(dir,"bridge.sock");
  await writeFile(socketPath,"must remain");
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketPath}),/unavailable/);
  assert.equal((await lstat(socketPath)).isFile(),true);
  await rm(socketPath);
  const listener=await startDshUnixRelayListener({enabled:true,handler:(_req,res)=>res.end("ok"),socketPath,socketGroupId:process.getgid()});
  t.after(()=>listener.close());
  await assert.rejects(startDshUnixRelayListener({enabled:true,handler:()=>{},socketPath}),/unavailable/);
  assert.equal((await post(socketPath)).status,200);
});
