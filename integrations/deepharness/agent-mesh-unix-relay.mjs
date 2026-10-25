/**
 * Draft-only local Unix HTTP relay handler for the existing DeepHarness mTLS
 * client. No listener is started, no socket is created and no Docker network
 * or service is modified by importing/constructing this module.
 *
 * A separately reviewed, least-privilege container may eventually own an
 * AF_UNIX socket shared with the 28server Agent Mesh receiver. Only that
 * container can resolve the fixed deepharness-mcp-backend Docker DNS name.
 */
import {createDshMtlsRequester,createDshPrivateBridgeClient,DSH_BRIDGE_PATH} from "./private-bridge-client.mjs";

import {createDshPlatformPrivateHttpHandler} from "./platform-admin-private-http-handler.mjs";

const MAX_REQUEST=16_384;
const MAX_RESPONSE=262_144;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const id=x=>typeof x==="string"&&ID.test(x);
const reject=res=>{
  if(res.headersSent){res.destroy();return;}
  res.writeHead(403,{"content-type":"application/json","cache-control":"no-store"});
  res.end('{"error":"deepharness_unavailable"}');
};
const keys=(x,allowed)=>isRecord(x)&&Object.keys(x).length===allowed.length&&
  allowed.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>allowed.includes(k));

function checkOperation(value,workspaceId,leadSessionId) {
  if(!isRecord(value)||value.workspaceId!==workspaceId)return null;
  const operation=value.operation;
  const common=["operation","workspaceId"];
  const scoped=[...common,"leadSessionId"];
  if(operation==="listTeams"){
    if(!keys(value,common))return null;
  }else if(operation==="getTeamStatus"||operation==="listTasks"){
    if(!keys(value,scoped)||value.leadSessionId!==leadSessionId)return null;
  }else if(operation==="readLeadChat"){
    if(!keys(value,[...scoped,"maxMessages"])||value.leadSessionId!==leadSessionId||
       !Number.isSafeInteger(value.maxMessages)||value.maxMessages<1||value.maxMessages>20)return null;
  }else if(operation==="sendLeadInstruction"){
    if(!keys(value,[...scoped,"requestId","text"])||value.leadSessionId!==leadSessionId||
       typeof value.requestId!=="string"||!UUID.test(value.requestId)||
       typeof value.text!=="string"||!value.text.trim()||value.text.includes("\0")||
       Buffer.byteLength(value.text,"utf8")>4096)return null;
  }else return null;
  return value;
}

async function call(client,input,leadSessionId) {
  const workspaceId=input.workspaceId;
  switch(input.operation){
    case "listTeams": {
      const teams=await client.listTeams({workspaceId});
      if(teams.length>256||teams.some(team=>!isRecord(team)||!id(team.leadSessionId)))throw Error();
      return teams.filter(team=>team.leadSessionId===leadSessionId);
    }
    case "getTeamStatus": {
      const team=await client.getTeamStatus({workspaceId,leadSessionId});
      if(team.leadSessionId!==leadSessionId||!Array.isArray(team.members)||!Array.isArray(team.tasks))throw Error();
      return team;
    }
    case "listTasks": {
      const tasks=await client.listTasks({workspaceId,leadSessionId});
      if(tasks.length>512)return Promise.reject(Error());
      return tasks;
    }
    case "readLeadChat": {
      const history=await client.readLeadChat({workspaceId,leadSessionId,maxMessages:input.maxMessages});
      if(!Array.isArray(history.messages)||history.messages.length>input.maxMessages||
         typeof history.hasMore!=="boolean")throw Error();
      return history;
    }
    case "sendLeadInstruction":
      return client.sendLeadInstruction({workspaceId,leadSessionId,
        requestId:input.requestId,text:input.text});
    default: throw Error();
  }
}

/**
 * Returns an HTTP request listener for an *operator-owned Unix socket only*.
 * The caller creating the server MUST independently secure socket ownership,
 * permissions, lifetime, and peer isolation before activation. Never serve
 * this handler on an Internet/TCP listener.
 *
 * postJson is the fixed hostname/SNI/CA/certificate-fingerprint pinned
 * private DSH requester. No MCP-supplied endpoint or key is accepted.
 */
export function createDshAgentMeshUnixRelayHandler({postJson,workspaceId,leadSessionId}={}){
  if(typeof postJson!=="function"||!id(workspaceId)||!id(leadSessionId))throw Error("dsh_relay_invalid_configuration");
  const client=createDshPrivateBridgeClient({postJson});
  return async function relay(req,res){
    try {
      if(req.method!=="POST"||req.url!==DSH_BRIDGE_PATH||
         req.headers["content-encoding"]!==undefined||
         req.headers["transfer-encoding"]!==undefined||
         !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"]??"")))throw Error();
      const lengthText=req.headers["content-length"];
      if(typeof lengthText!=="string"||!/^[1-9][0-9]*$/.test(lengthText))throw Error();
      const declared=Number(lengthText);
      if(!Number.isSafeInteger(declared)||declared>MAX_REQUEST)throw Error();
      let total=0;const chunks=[];
      for await (const chunk of req){
        total+=chunk.length;
        if(total>declared||total>MAX_REQUEST)throw Error();
        chunks.push(Buffer.from(chunk));
      }
      if(total!==declared)throw Error();
      const input=checkOperation(JSON.parse(Buffer.concat(chunks).toString("utf8")),workspaceId,leadSessionId);
      if(input===null)throw Error();
      const result=await call(client,input,leadSessionId);
      const json=JSON.stringify({result});
      if(Buffer.byteLength(json,"utf8")>MAX_RESPONSE)throw Error();
      res.writeHead(200,{"content-type":"application/json; charset=utf-8",
        "cache-control":"no-store","x-content-type-options":"nosniff"});
      res.end(json);
    }catch{reject(res);}
  };
}

/** Wiring factory does not open a listener and keeps TLS bytes host-side. */
export function createDshAgentMeshUnixRelayOverMtls({tls,serverFingerprintSha256,workspaceId,leadSessionId}={}){
  if(!isRecord(tls))throw Error("dsh_relay_invalid_configuration");
  const postJson=createDshMtlsRequester({
    ca:tls.ca,cert:tls.cert,key:tls.key,serverFingerprintSha256,
  });
  return createDshAgentMeshUnixRelayHandler({postJson,workspaceId,leadSessionId});
}

/**
 * Platform branch of the SAME least-privilege Unix relay.
 * Serve only with startDshUnixRelayListener at the fixed V2 socket in a
 * relay-owned 02710 directory / 0660 socket, with an explicitly trusted,
 * dedicated agent group. Filesystem DAC is the local access boundary; this
 * does not claim to inspect SO_PEERCRED. The backend independently requires
 * a verified and pinned mTLS client certificate and explicit host authority.
 */
export function createDshPlatformUnixRelayHandler({postJson}={}){
 if(typeof postJson!=="function")throw Error("dsh_relay_invalid_configuration");
 const local=connection=>connection&&connection.remoteAddress===undefined&&
  connection.remotePort===undefined&&connection.destroyed!==true;
 return createDshPlatformPrivateHttpHandler({
  auditStage:stage=>{if(["request","peer","body","contract","upstream","response"].includes(stage))
    process.stderr.write(`DSH_PLATFORM_RELAY_FAILURE_STAGE ${stage}\n`);},
  connectionForRequest:req=>local(req.socket)?req.socket:undefined,
  relay:{dispatch:async(connection,envelope)=>{
   if(!local(connection))throw Error("dsh_relay_invalid_connection");
   return postJson(envelope);
  }},
 });
}
export function createDshPlatformUnixRelayOverMtls({tls,serverFingerprintSha256}={}){
 if(!isRecord(tls))throw Error("dsh_relay_invalid_configuration");
 return createDshPlatformUnixRelayHandler({postJson:createDshMtlsRequester({
  ca:tls.ca,cert:tls.cert,key:tls.key,serverFingerprintSha256,protocol:"platform-v2",
 })});
}
