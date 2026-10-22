/**
 * Opt-in V2 registration for the existing Wandora MCP server.
 * No grants, targets, listeners or host services are provisioned here.
 */
import path from "node:path";
import {getDshPlatformGrantStore} from "./platform-admin-grant-store.mjs";
import {composeDshPlatformOverAgentMesh} from "./platform-admin-composition.mjs";
import {createDshPlatformToolDefs} from "./platform-admin-mcp-tools.mjs";

const deny=()=>{throw Error("deepharness_platform_runtime_unavailable");};
let pending;
export async function loadDshPlatformToolDefs(){
 if(process.env.DSH_PLATFORM_MCP_ENABLED!=="1")return [];
 if(process.env.AUTH_MODE!=="oauth"||
    ["1","true"].includes((process.env.MOCK_MODE??"").toLowerCase()))deny();
 pending??=(async()=>{
  const [{env},{getTarget},{dispatchAgentOperation},{effectiveTargetEnabled}]=await Promise.all([
   import("../../dist/lib/env.js"),import("../../dist/config/targets.js"),
   import("../../dist/agent/gateway.js"),import("../../dist/state/store.js"),
  ]);
  const file=process.env.DSH_PLATFORM_GRANT_STATE_FILE;
  if(!file||!path.isAbsolute(file)||
     path.dirname(path.resolve(file))!==path.resolve(path.dirname(env.STATE_FILE))||
     path.resolve(file)===path.resolve(env.STATE_FILE))deny();
  const lookupCurrentTarget=()=>{
   const target=getTarget("deepharness-platform-private");
   return target&&effectiveTargetEnabled(target.id,target.enabled)?target:undefined;
  };
  // Validate target before creating any on-disk state. Never reuse V1 target.
  const target=lookupCurrentTarget();
  const {validateDshPlatformTarget}=await import("./platform-admin-agent-mesh-client.mjs");
  validateDshPlatformTarget(target);
  const policy=composeDshPlatformOverAgentMesh({
   grantStore:getDshPlatformGrantStore({file}),target,lookupCurrentTarget,
   dispatchAgentOperation,
  });
  return createDshPlatformToolDefs(policy);
 })().catch(error=>{pending=undefined;throw error;});
 return pending;
}
