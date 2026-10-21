/**
 * Opt-in 28server Agent Mesh receiver for DSH semantic operations.
 *
 * The only transport is a fixed, owner-provisioned AF_UNIX socket.
 * It does not provide host network access, Docker privileges, credentials,
 * an HTTP listener or a route to the internal DSH Docker network.
 * A separate reviewed relay MUST authenticate the local peer and perform
 * pinned end-to-end mTLS to the private DSH endpoint. Without that relay,
 * every call fails closed. This handler is inert unless enabled explicitly.
 */
import http from "node:http";
import {lstat} from "node:fs/promises";
import {dirname} from "node:path";
import type {ExecOptions,ExecResult} from "../ssh/pool.js";

const SOCKET="/run/wandora/deepharness-semantic/bridge.sock";
const ENDPOINT="/wandora/dsh-bridge/v1";
const OP="deepharness.semantic";
const MAX_REQUEST=16_384,MAX_RESPONSE=262_144;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function deny():never {throw Error("deepharness_agent_mesh_denied");}
function unavailable():never {throw Error("deepharness_agent_mesh_unavailable");}
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown>{
  if(!record(v)||Object.keys(v).length!==keys.length||
     keys.some(key=>!Object.hasOwn(v,key))||Object.keys(v).some(key=>!keys.includes(key)))deny();
}
function safeId(v:unknown):string {
  if(typeof v!=="string"||!ID.test(v))deny();
  return v as string;
}
type SemanticOperation="listTeams"|"getTeamStatus"|"listTasks"|"readLeadChat"|"sendLeadInstruction";
function validatedPayload(value:unknown,env:NodeJS.ProcessEnv):{operation:SemanticOperation;body:string;leadId:string}{
  exact(value,["op","args"]);
  if(value.op!==OP)deny();
  const args=value.args;
  if(!record(args))deny();
  const operation=args.operation;
  if(!["listTeams","getTeamStatus","listTasks","readLeadChat","sendLeadInstruction"].includes(String(operation)))deny();
  const op=operation as SemanticOperation;
  const common=["operation","workspaceId"];
  const withLead=[...common,"leadSessionId"];
  if(op==="listTeams")exact(args,common);
  else if(op==="getTeamStatus"||op==="listTasks")exact(args,withLead);
  else if(op==="readLeadChat"){
    exact(args,[...withLead,"maxMessages"]);
    if(!Number.isSafeInteger(args.maxMessages)||Number(args.maxMessages)<1||Number(args.maxMessages)>20)deny();
  }else{
    exact(args,[...withLead,"requestId","text"]);
    if(typeof args.requestId!=="string"||!UUID.test(args.requestId)||
       typeof args.text!=="string"||!args.text.trim()||args.text.includes("\0")||
       Buffer.byteLength(args.text,"utf8")>4096)deny();
  }
  const workspace=safeId(args.workspaceId);
  const expectedWorkspace=safeId(env.DSH_AGENT_MESH_WORKSPACE_ID);
  const expectedLead=safeId(env.DSH_AGENT_MESH_LEAD_SESSION_ID);
  if(workspace!==expectedWorkspace)deny();
  if(op!=="listTeams"&&safeId(args.leadSessionId)!==expectedLead)deny();
  const body=JSON.stringify(args);
  if(Buffer.byteLength(body,"utf8")>MAX_REQUEST)deny();
  return {operation:op,body,leadId:expectedLead};
}
type SocketStat={isSocket:()=>boolean;isDirectory:()=>boolean;isSymbolicLink?:()=>boolean;uid:number;gid:number;mode:number};
type Dependencies={
  env?:NodeJS.ProcessEnv;
  socketPath?:string; // test-only injection; not sourced from request, CLI or options
  lstat?:(path:string)=>Promise<SocketStat>;
  request?:typeof http.request;
};
async function requireLocalSocket(
  socket:string,stat:(path:string)=>Promise<SocketStat>,env:NodeJS.ProcessEnv,
):Promise<void>{
  try {
    const relayUidText=env.DSH_AGENT_MESH_RELAY_UID??"";
    const groupText=env.DSH_AGENT_MESH_SOCKET_GID??"";
    if(!/^[1-9][0-9]*$/.test(relayUidText)||!/^[1-9][0-9]*$/.test(groupText))unavailable();
    const relayUid=Number(relayUidText),socketGid=Number(groupText),agentUid=process.getuid?.();
    if(!Number.isSafeInteger(relayUid)||!Number.isSafeInteger(socketGid)||
       !Number.isSafeInteger(agentUid)||agentUid===0||agentUid===relayUid)unavailable();
    const agentGroups=[process.getgid?.(),...(process.getgroups?.()??[])];
    if(!agentGroups.includes(socketGid))unavailable();
    const folder=await stat(dirname(socket));
    const target=await stat(socket);
    if(!folder.isDirectory()||folder.isSymbolicLink?.()||
       folder.uid!==relayUid||folder.gid!==socketGid||
       (folder.mode&0o7777)!==0o2710||
       !target.isSocket()||target.isSymbolicLink?.()||
       target.uid!==relayUid||target.gid!==socketGid||
       (target.mode&0o777)!==0o660)unavailable();
  } catch { unavailable(); }
}
function sanitize(operation:SemanticOperation,leadId:string,result:unknown):unknown {
  if(operation==="sendLeadInstruction"){
    // The requestId check is performed on the untrusted returned data below.
    return result;
  }
  if(operation==="getTeamStatus"){
    if(!record(result)||result.leadSessionId!==leadId||
       !Array.isArray(result.members)||!Array.isArray(result.tasks))deny();
  }else if(operation==="readLeadChat"){
    if(!record(result)||!Array.isArray(result.messages)||
       result.messages.length>20||typeof result.hasMore!=="boolean")deny();
  }else if(!Array.isArray(result))deny();
  if(operation==="listTeams"){
    if(!Array.isArray(result)||result.length>256||
       result.some(team=>!record(team)||typeof team.leadSessionId!=="string"))deny();
    // Never return another workspace Lead's Team to the control plane.
    return result.filter(team=>team.leadSessionId===leadId);
  }
  return result;
}
function postSocket(socket:string,body:string,timeoutMs:number,request:typeof http.request):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    let settled=false,bytes=0;
    const fail=()=>{if(!settled){settled=true;reject(Error("deepharness_agent_mesh_unavailable"));}};
    try{
      const req=request({socketPath:socket,path:ENDPOINT,method:"POST",agent:false,
        headers:{"content-type":"application/json","accept":"application/json",
          "content-length":Buffer.byteLength(body)}},res=>{
        if(res.statusCode!==200||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(res.headers["content-type"]??""))||
           res.headers["content-encoding"]!==undefined){res.destroy();fail();return;}
        const chunks:Buffer[]=[];
        res.on("data",(chunk:Buffer)=>{
          bytes+=chunk.length;
          if(bytes>MAX_RESPONSE){res.destroy();fail();return;}
          chunks.push(Buffer.from(chunk));
        });
        res.once("end",()=>{
          try{
            const packet=JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            exact(packet,["result"]);
            if(!settled){settled=true;resolve(packet.result);}
          }catch{fail();}
        });
        res.once("error",fail);
      });
      req.setTimeout(timeoutMs,()=>req.destroy(Error("deadline")));
      req.once("error",fail);
      req.end(body);
    }catch{fail();}
  });
}
export async function executeDshAgentOperation(
  request:unknown,opts:ExecOptions={},dependencies:Dependencies={},
):Promise<ExecResult>{
  const started=Date.now(),env=dependencies.env??process.env;
  try{
    if(env.DSH_AGENT_MESH_ENABLED!=="1")unavailable();
    const {operation,body,leadId}=validatedPayload(request,env);
    const socket=dependencies.socketPath??SOCKET;
    await requireLocalSocket(socket,dependencies.lstat??lstat,env);
    const ms=Math.min(Math.max(opts.timeoutMs??10_000,1000),30_000);
    const result=await postSocket(socket,body,ms,dependencies.request??http.request);
    if(operation==="sendLeadInstruction"){
      const id=(request as {args:{requestId:string}}).args.requestId;
      if(!record(result)||result.accepted!==true||result.requestId!==id||
         Object.keys(result).some(k=>!["accepted","requestId"].includes(k)))deny();
    }
    const safe=sanitize(operation,leadId,result);
    const out=JSON.stringify(safe);
    if(Buffer.byteLength(out,"utf8")>MAX_RESPONSE)deny();
    return {code:0,stdout:out,stderr:"",durationMs:Date.now()-started,truncated:false,timedOut:false};
  }catch{
    return {code:1,stdout:"",stderr:"deepharness_agent_mesh_unavailable",
      durationMs:Date.now()-started,truncated:false,timedOut:false};
  }
}
