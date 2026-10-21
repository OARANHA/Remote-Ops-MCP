/**
 * Optional DeepHarness V2 host-side operation dispatch. No listener and no MCP
 * registration. Runs only behind the separately authenticated private bridge.
 *
 * Each mutation requires a DSH-side durable replay/commit provider in addition
 * to the OAuth-side authorization and grant/replay provider. This intentionally
 * fails closed until both sides are wired; it never accepts host paths, shell
 * commands, caller OAuth claims, or a dynamic target.
 */
import {createHash} from "node:crypto";
import {
  validateDshPlatformEnvelope,actionForDshPlatformOperation,
} from "./platform-admin-contract.mjs";

const deny=()=>{throw Error("deepharness_platform_host_unavailable");};
const METHODS=Object.freeze([
  "listWorkspaces","createWorkspace","renameWorkspace","listWorkspaceSessions",
  "createLeadSession","createTeammate","createTeamTask","updateTeamTask",
]);
const READ=new Set(["listWorkspaces","listWorkspaceSessions"]);
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);

function detach(value){
  let serialized;
  try{serialized=JSON.stringify(value);}catch{deny();}
  if(typeof serialized!=="string"||Buffer.byteLength(serialized,"utf8")>262144)deny();
  const result=JSON.parse(serialized);
  if(!Array.isArray(result)&&!obj(result))deny();
  return result;
}
function params(operation,input){
  switch(operation){
    case "listWorkspaces": return null;
    case "createWorkspace":return {name:input.name,title:input.title};
    case "renameWorkspace":return {workspaceId:input.workspaceId,title:input.title};
    case "listWorkspaceSessions":return {workspaceId:input.workspaceId};
    case "createLeadSession":return {workspaceId:input.workspaceId,agentPreset:input.agentPreset};
    case "createTeammate":return {workspaceId:input.workspaceId,
      leadSessionId:input.leadSessionId,name:input.name,description:input.description,
      prompt:input.prompt,provider:input.provider,context:input.context};
    case "createTeamTask":return {workspaceId:input.workspaceId,
      leadSessionId:input.leadSessionId,subject:input.subject,description:input.description};
    case "updateTeamTask":return {workspaceId:input.workspaceId,
      leadSessionId:input.leadSessionId,taskId:input.taskId,
      expectedRevision:input.expectedRevision,action:input.action,owner:input.owner};
    default: deny();
  }
}

export function createDshPlatformHostDispatcher({admin,withDurableReplay}={}){
  if(!obj(admin)||typeof withDurableReplay!=="function"||
    METHODS.some(method=>typeof admin[method]!=="function"))deny();
  return Object.freeze({
    async dispatch(envelope){
      const request=validateDshPlatformEnvelope(envelope);
      const operation=request.args.operation;
      const action=actionForDshPlatformOperation(operation);
      const input=params(operation,request.args);
      const call=async()=>detach(await (
        input===null?admin[operation]():admin[operation](input)
      ));
      if(READ.has(operation))return call();
      // The caller-supplied UUID is already re-keyed to its full OAuth
      // principal by the gateway's durable write gate. DSH independently
      // stores its exact replay key + payload digest against this host method.
      const requestId=request.args.requestId;
      const payloadHash=createHash("sha256").update(JSON.stringify(request.args)).digest("hex");
      const receipt=await withDurableReplay(Object.freeze({
        requestId,operation,action,payloadHash,
      }),call);
      if(!obj(receipt)||receipt.requestId!==requestId||
         receipt.action!==action||receipt.payloadHash!==payloadHash||
         receipt.committed!==true||typeof receipt.duplicate!=="boolean")deny();
      return detach(receipt.result);
    },
  });
}
