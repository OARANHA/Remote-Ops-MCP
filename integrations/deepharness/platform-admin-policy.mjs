/**
 * OAuth-bound platform administration policy for a future V2 DSH bridge.
 *
 * This module contains NO grant provisioning, MCP registry, network transport
 * or auto-enable. An operator-owned persistent grant store and a separate
 * revocation-serialized write transaction MUST be supplied. The token/session
 * principal is supplied by existing OAuth middleware, never by tool args.
 */
import {createHash} from "node:crypto";
import {makeDshPlatformEnvelope,actionForDshPlatformOperation} from "./platform-admin-contract.mjs";
const deny=()=>{throw Error("deepharness_platform_capability_denied");};
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RECEIPT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const READ=new Set(["workspace.list","session.list","skills.list","team.member.read"]);
const ACTIONS=new Set([
  "workspace.list","skills.list","workspace.create","workspace.rename",
  "session.list","team.member.read","session.create","team.member.create",
  "team.task.create","team.task.update",
]);
function principalOf(ctx){
  if(!obj(ctx))deny();
  const {actor,clientId,sessionId}=ctx;
  if(typeof clientId!=="string"||!ID.test(clientId)||
     typeof sessionId!=="string"||!ID.test(sessionId)||
     actor!=="oauth:"+clientId+":"+sessionId.slice(0,12))deny();
  return Object.freeze({actor,clientId,sessionId});
}
function validateGrant(grant,principal,action){
  if(!obj(grant)||grant.actor!==principal.actor||
    grant.clientId!==principal.clientId||grant.sessionId!==principal.sessionId||
    grant.rootScope!=="managed"||grant.revokedAt!==null||
    typeof grant.revision!=="string"||!ID.test(grant.revision)||
    !Array.isArray(grant.actions)||grant.actions.length<1||
    new Set(grant.actions).size!==grant.actions.length||
    grant.actions.some(x=>!ACTIONS.has(x))||!grant.actions.includes(action))deny();
  return grant.revision;
}
function scopedHostRequestId(principal,operation,requestId){
  const bytes=createHash("sha256").update(JSON.stringify([
    principal.actor,principal.clientId,principal.sessionId,operation,requestId,
  ])).digest();
  bytes[6]=(bytes[6]&0x0f)|0x50;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.subarray(0,16).toString("hex");
  return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+
    "-"+hex.slice(16,20)+"-"+hex.slice(20,32);
}
function boundedResult(result){
  if(result===null||typeof result!=="object")deny();
  let serialized;
  try {serialized=JSON.stringify(result);} catch {deny();}
  if(typeof serialized!=="string"||
    Buffer.byteLength(serialized,"utf8")>262144)deny();
  // Return exactly what was size-checked. Returning the source object lets
  // custom toJSON/getters conceal fields from the limit and leak on spread.
  const detached=JSON.parse(serialized);
  if(detached===null||typeof detached!=="object")deny();
  return detached;
}
export function createDshPlatformPolicy({
  lookupCurrentGrant,withAuthorizedWrite,dispatchEnvelope,
}={}){
  if(typeof lookupCurrentGrant!=="function"||
    typeof withAuthorizedWrite!=="function"||
    typeof dispatchEnvelope!=="function")deny();
  async function current(principal,action){
    const grant=await lookupCurrentGrant(principal);
    return validateGrant(grant,principal,action);
  }
  return Object.freeze({
    async execute(trustedCaller,operation){
      const principal=principalOf(trustedCaller);
      // Validate the caller's exact business envelope before any operation.
      const original=makeDshPlatformEnvelope(operation);
      const action=actionForDshPlatformOperation(operation.operation);
      // Only mutation UUIDs are re-keyed; OAuth principal never crosses mTLS.
      const envelope=READ.has(action)?original:makeDshPlatformEnvelope({
        ...operation,requestId:scopedHostRequestId(
          principal,operation.operation,operation.requestId,
        ),
      });
      const revision=await current(principal,action);
      if(READ.has(action)){
        const result=boundedResult(await dispatchEnvelope(envelope));
        // Deny stale/revoked reads even if revocation races with an async result.
        if((await current(principal,action))!==revision)deny();
        return result;
      }
      const {requestId}=operation;
      const payloadHash=createHash("sha256").update(JSON.stringify(original.args)).digest("hex");
      const context=Object.freeze({
        ...principal,action,revision,requestId,payloadHash,
        workspaceId:operation.workspaceId??null,
      });
      // Provider MUST serialize current grant/revocation and store replay
      // identity BEFORE admitting the operation. No optimistic preflight alone.
      const receipt=await withAuthorizedWrite(context,async()=>{
        if((await current(principal,action))!==revision)deny();
        return boundedResult(await dispatchEnvelope(envelope));
      });
      if(!obj(receipt)||receipt.authorizationCheckedAtCommit!==true||
        receipt.grantRevision!==revision||receipt.accepted!==true||
        typeof receipt.receiptId!=="string"||!RECEIPT.test(receipt.receiptId)||
        typeof receipt.duplicate!=="boolean")deny();
      return Object.freeze({
        ...boundedResult(receipt.result),
        receipt_id:receipt.receiptId,duplicate:receipt.duplicate,
      });
    },
  });
}
