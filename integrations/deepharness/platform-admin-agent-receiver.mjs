/**
 * Inert V2 Agent Mesh host receiver. Deliberately NOT registered in the agent
 * dispatcher until the separate DSH private listener and host authority
 * checks are independently verified. Never reuses the V1 TEAM_3 socket.
 */
import http from "node:http";
import {lstat} from "node:fs/promises";
import {dirname} from "node:path";
import {validateDshPlatformEnvelope} from "./platform-admin-contract.mjs";

const SOCKET="/run/wandora/deepharness-platform/bridge.sock";
const ROUTE="/wandora/dsh-platform/v2";
const deny=()=>{throw Error("deepharness_platform_receiver_unavailable");};
const maxResponse=262144;
async function requireSocket(socket,stat,env,agentUid,agentGroups){
 const uid=env.DSH_PLATFORM_RELAY_UID??"",gid=env.DSH_PLATFORM_SOCKET_GID??"";
 if(!/^[1-9][0-9]*$/.test(uid)||!/^[1-9][0-9]*$/.test(gid))deny();
 const owner=Number(uid),group=Number(gid);
 if(!Number.isSafeInteger(owner)||!Number.isSafeInteger(group)||
    !Number.isSafeInteger(agentUid)||agentUid===0||agentUid===owner||
    !agentGroups.includes(group))deny();
 let dir,sock;
 try{[dir,sock]=await Promise.all([stat(dirname(socket)),stat(socket)]);}catch{deny();}
 if(!dir.isDirectory()||dir.isSymbolicLink?.()||dir.uid!==owner||
    dir.gid!==group||(dir.mode&0o7777)!==0o2710||
    !sock.isSocket()||sock.isSymbolicLink?.()||sock.uid!==owner||
    sock.gid!==group||(sock.mode&0o777)!==0o660)deny();
}
function post(socket,payload,request,timeout){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const fail=()=>{if(!settled){settled=true;reject(Error("deepharness_platform_receiver_unavailable"));}};
  try{
   const body=JSON.stringify(payload);
   const req=request({socketPath:socket,path:ROUTE,method:"POST",agent:false,
     headers:{"content-type":"application/json","accept":"application/json",
       "content-length":Buffer.byteLength(body)}},res=>{
    if(res.statusCode!==200||
       !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(res.headers["content-type"]??""))||
       res.headers["content-encoding"]!==undefined){res.destroy();fail();return;}
    let bytes=0;const chunks=[];
    res.on("data",chunk=>{
     bytes+=chunk.length;if(bytes>maxResponse){res.destroy();fail();return;}
     chunks.push(Buffer.from(chunk));
    });
    res.once("end",()=>{
     try{
      const packet=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(!packet||typeof packet!=="object"||Array.isArray(packet)||
        Object.keys(packet).length!==1||!Object.hasOwn(packet,"result")||
        !packet.result||typeof packet.result!=="object"){fail();return;}
      if(!settled){settled=true;resolve(packet.result);}
     }catch{fail();}
    });
    res.once("error",fail);
   });
   req.setTimeout(timeout,()=>req.destroy(Error("deadline")));
   req.once("error",fail);req.end(body);
  }catch{fail();}
 });
}
export async function executeDshPlatformAgentOperation(envelope,opts={},deps={}){
 const started=Date.now(),env=deps.env??process.env;
 let stage="enabled";
 try{
  if(env.DSH_PLATFORM_AGENT_ENABLED!=="1")deny();
  stage="contract";
  const payload=validateDshPlatformEnvelope(envelope);
  const socket=deps.socketPath??SOCKET;
  const uid=deps.agentUid??process.getuid?.();
  const groups=deps.agentGroups??[process.getgid?.(),...(process.getgroups?.()??[])];
  stage="socket";
  await requireSocket(socket,deps.lstat??lstat,env,uid,groups);
  const timeout=Math.min(Math.max(opts.timeoutMs??10000,1000),30000);
  stage="relay_http";
  const result=await post(socket,payload,deps.request??http.request,timeout);
  stage="response";
  const output=JSON.stringify(result);
  if(Buffer.byteLength(output,"utf8")>maxResponse)deny();
  return {code:0,stdout:output,stderr:"",durationMs:Date.now()-started,
   truncated:false,timedOut:false};
 }catch{
  // Preserve the existing Agent Mesh error contract; log only fixed stage labels.
  try{(deps.auditStage??(label=>console.warn("DSH_PLATFORM_RECEIVER_FAILURE_STAGE",label)))(stage);}catch{}
  return {code:1,stdout:"",stderr:"deepharness_platform_receiver_unavailable",
   durationMs:Date.now()-started,truncated:false,timedOut:false};
 }
}
