/**
 * Remote-Ops adapter for the fixed private DSH semantic HTTPS client.
 * OAuth identity and grants stay local; only scoped workspace/Lead operations
 * cross the mTLS boundary. No arbitrary URL, operation, or host input exists.
 */
import {createHash} from "node:crypto";

const deny=()=>{throw Error("deepharness_private_bridge_denied");};
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const obj=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function id(value){if(typeof value!=="string"||!ID.test(value))deny();return value;}
function authority(auth){
  if(!obj(auth))deny();
  const scope={workspaceId:id(auth.workspaceId),leadSessionId:id(auth.leadSessionId),
    revision:id(auth.revision),actor:id(auth.actor),clientId:id(auth.clientId),sessionId:id(auth.sessionId)};
  if(scope.actor!=="oauth:"+scope.clientId+":"+scope.sessionId.slice(0,12))deny();
  return scope;
}
function promptRequestId(scope,key){
  const hash=createHash("sha256").update(JSON.stringify([
    scope.actor,scope.clientId,scope.sessionId,scope.workspaceId,scope.leadSessionId,key,
  ])).digest();
  hash[6]=(hash[6]&0x0f)|0x50;hash[8]=(hash[8]&0x3f)|0x80;
  const hex=hash.subarray(0,16).toString("hex");
  return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20,32);
}
function text(value,max){if(typeof value!=="string"||value.length>max)deny();return value;}
function validateTeam(scope,value){
  if(!obj(value)||value.leadSessionId!==scope.leadSessionId||
     !Array.isArray(value.members)||value.members.length<1||value.members.length>128||
     !Array.isArray(value.tasks)||value.tasks.length>512)deny();
  const members=value.members.map(member=>{
    if(!obj(member)||!["lead","teammate"].includes(member.role)||
       !["provisioning","active","failed"].includes(member.phase))deny();
    return {id:id(member.id),role:member.role,name:text(member.name,120),phase:member.phase};
  });
  if(members.filter(member=>member.role==="lead"&&member.id===scope.leadSessionId&&member.phase==="active").length!==1||
     members.filter(member=>member.role==="lead").length!==1)deny();
  const tasks=value.tasks.map(task=>{
    if(!obj(task)||!Number.isSafeInteger(task.revision)||task.revision<1||
       !["pending","in_progress","completed"].includes(task.status)||
       typeof task.ready!=="boolean"||!Array.isArray(task.blockedBy)||!Array.isArray(task.writeScopes)||
       !Array.isArray(task.writeScopeWarnings))deny();
    return {id:id(task.id),status:task.status,subject:text(task.subject,240),
      description:text(task.description,500)};
  });
  if(new Set(members.map(member=>member.id)).size!==members.length||
     new Set(tasks.map(task=>task.id)).size!==tasks.length)deny();
  return {workspace_id:scope.workspaceId,lead_session_id:scope.leadSessionId,members,tasks};
}

export function createRemoteDshPrivateBridgeBackend({client,withAuthorizedLeadCommit}={}){
  if(typeof client?.getTeamStatus!=="function"||typeof client?.readLeadChat!=="function"||
     typeof client?.sendLeadInstruction!=="function"||typeof withAuthorizedLeadCommit!=="function")deny();
  const readTeam=async auth=>{
    const scope=authority(auth);
    return validateTeam(scope,await client.getTeamStatus({
      workspaceId:scope.workspaceId,leadSessionId:scope.leadSessionId,
    }));
  };
  return Object.freeze({
    readAuthorizedTeam:readTeam,
    async readAuthorizedChat(auth){
      const scope=authority(auth),limit=auth.limit;
      if(!Number.isSafeInteger(limit)||limit<1||limit>20)deny();
      const result=await client.readLeadChat({workspaceId:scope.workspaceId,
        leadSessionId:scope.leadSessionId,maxMessages:limit});
      if(!obj(result)||!Array.isArray(result.messages)||result.messages.length>limit||
         typeof result.hasMore!=="boolean")deny();
      const messages=result.messages.map(message=>{
        if(!obj(message)||!["user","assistant"].includes(message.role))deny();
        return {role:message.role,text:text(message.text,6000)};
      }).filter(message=>message.text.length>0);
      return {workspace_id:scope.workspaceId,lead_session_id:scope.leadSessionId,messages};
    },
    async commitAuthorizedInstruction(auth){
      const scope=authority(auth);
      if(auth.action!=="lead.instruct"||typeof auth.instruction!=="string"||
         !auth.instruction.trim()||Buffer.byteLength(auth.instruction,"utf8")>4096||
         auth.instruction.includes("\0")||typeof auth.idempotencyKey!=="string"||
         !UUID.test(auth.idempotencyKey))deny();
      const payloadHash=createHash("sha256").update(auth.instruction,"utf8").digest("hex");
      const receipt=await withAuthorizedLeadCommit({
        ...scope,action:"lead.instruct",idempotencyKey:auth.idempotencyKey,payloadHash,
      },async()=>{
        // Re-resolve the Lead immediately before dispatch; the DSH endpoint
        // independently checks current workspace membership and Lead projection.
        await readTeam(scope);
        const requestId=promptRequestId(scope,auth.idempotencyKey);
        const ack=await client.sendLeadInstruction({workspaceId:scope.workspaceId,
          leadSessionId:scope.leadSessionId,requestId,text:auth.instruction});
        if(ack?.accepted!==true||ack.requestId!==requestId)deny();
        return {accepted:true};
      });
      if(!obj(receipt)||receipt.accepted!==true||receipt.authorizationCheckedAtCommit!==true||
         receipt.grantRevision!==scope.revision||typeof receipt.receiptId!=="string"||
         !ID.test(receipt.receiptId)||typeof receipt.duplicate!=="boolean")deny();
      return {accepted:true,authorizationCheckedAtCommit:true,grantRevision:scope.revision,
        receiptId:receipt.receiptId,duplicate:receipt.duplicate};
    },
  });
}
