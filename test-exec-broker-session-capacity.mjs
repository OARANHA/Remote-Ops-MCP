#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"romcp-exec-capacity-"));
const socket=path.join(tmp,"exec.sock");
const broker=spawn(process.execPath,["dist/exec/broker.js"],{
  cwd:process.cwd(),
  env:{...process.env,WANDORA_EXEC_BROKER_SOCKET:socket,WANDORA_EXEC_ROOTS:tmp,WANDORA_EXEC_PROGRAMS:"node",WANDORA_EXEC_MAX_SESSIONS:"3"},
  stdio:["ignore","pipe","pipe"],
});
let logs="";
broker.stdout.on("data",(d)=>logs+=d.toString());
broker.stderr.on("data",(d)=>logs+=d.toString());
for(let i=0;i<80&&!fs.existsSync(socket);i++) await new Promise(r=>setTimeout(r,50));
if(!fs.existsSync(socket))throw new Error("exec broker did not start: "+logs);

function request(op,args={}){
  return new Promise((resolve,reject)=>{
    const s=net.createConnection({path:socket});
    let data="";
    s.setEncoding("utf8");
    s.on("connect",()=>s.write(JSON.stringify({op,args})+"\n"));
    s.on("data",(chunk)=>{
      data+=chunk;
      const nl=data.indexOf("\n");
      if(nl<0)return;
      try{resolve(JSON.parse(data.slice(0,nl)));}
      catch(e){reject(e);}
      finally{s.destroy();}
    });
    s.on("error",reject);
  });
}
async function waitClosed(id){
  for(let i=0;i<100;i++){
    const r=await request("process.read",{session_id:id,offset:0,max_chars:1024});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(r.result.running===false)return r.result;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error("session did not close: "+id);
}
async function startLong(){
  const r=await request("process.start",{cwd:tmp,program:"node",argv:["-e","setTimeout(()=>{},10000)"]});
  assert.equal(r.ok,true,JSON.stringify(r));
  return r.result.session_id;
}

const ids=[];
try{
  ids.push(await startLong(),await startLong(),await startLong());

  const full=await request("process.start",{cwd:tmp,program:"node",argv:["-e","setTimeout(()=>{},10000)"]});
  assert.equal(full.ok,false,JSON.stringify(full));
  assert.equal(full.error?.message,"session_capacity");

  const before=await request("process.list");
  assert.equal(before.ok,true);
  assert.equal(before.result.max_active_sessions,3);
  assert.equal(before.result.active_sessions,3);
  assert.equal(before.result.sessions.length,3);

  const killed=await request("process.kill",{session_id:ids[0],signal:"SIGKILL"});
  assert.equal(killed.ok,true,JSON.stringify(killed));
  await waitClosed(ids[0]);

  const replacement=await startLong();
  ids.push(replacement);

  const after=await request("process.list");
  assert.equal(after.ok,true);
  assert.equal(after.result.max_active_sessions,3);
  assert.equal(after.result.active_sessions,3);
  assert.equal(after.result.sessions.length,4,"completed sessions remain readable but must not consume active capacity");

  console.log("EXEC_BROKER_ACTIVE_SESSION_CAPACITY=GREEN");
}finally{
  for(const id of ids){
    const r=await request("process.read",{session_id:id,offset:0,max_chars:1}).catch(()=>null);
    if(r?.ok&&r.result.running) await request("process.kill",{session_id:id,signal:"SIGKILL"}).catch(()=>null);
  }
  broker.kill("SIGTERM");
  await new Promise(r=>broker.once("exit",r));
  fs.rmSync(tmp,{recursive:true,force:true});
}
