/**
 * Optional V2 Agent Mesh transport for deepharness.platform.
 * This is NOT the existing deepharness.semantic LAB target. No executable
 * shell, Docker, target selection or grant is accepted from the MCP caller.
 * No host relay is installed by this factory.
 */
import {validateDshPlatformEnvelope} from "./platform-admin-contract.mjs";
const deny=()=>{throw Error("deepharness_platform_agent_mesh_unavailable");};
const TARGET="deepharness-platform-private";
const CAP="deepharness.platform";
const DEVICE=/^dev_[A-Za-z0-9_-]{8,80}$/;
const FORBIDDEN=[
 "allowedPaths","allowedGitRepos","allowedDockerContainers",
 "allowedDockerExecContainers","allowedDockerExecPrograms",
 "allowedDockerActions","allowedDockerImageLoadRoots",
 "allowedDockerCandidateImagePrefixes","allowedDockerCandidateNetworks",
 "allowedDockerCandidateNamePrefixes","allowedDockerCandidateHostPorts",
 "allowedDockerCandidateContainerPorts","allowedServices",
 "allowedServiceActions","allowedAdminPrograms","allowedAdminCwds",
 "allowedWritePaths","allowedProcessCwds","allowedProcessPrograms",
];
export function validateDshPlatformTarget(t){
 if(!t||typeof t!=="object"||Array.isArray(t)||
    t.id!==TARGET||t.transport!=="agent"||t.environment!=="development"||
    t.capabilityProfile!=="semantic-operator"||t.enabled!==true||
    typeof t.deviceId!=="string"||!DEVICE.test(t.deviceId)||
    !Array.isArray(t.allowedSemanticCapabilities)||
    t.allowedSemanticCapabilities.length!==1||
    t.allowedSemanticCapabilities[0]!==CAP||
    !FORBIDDEN.every(k=>t[k]===undefined||
     Array.isArray(t[k])&&t[k].length===0))deny();
 return Object.freeze({id:TARGET,deviceId:t.deviceId});
}
export function createDshPlatformAgentMeshDispatcher({
 target,lookupCurrentTarget,dispatchAgentOperation,timeoutMs=10_000,auditFailure=()=>{},
}={}){
 const trusted=validateDshPlatformTarget(target);
 const audit=stage=>{try{auditFailure(stage);}catch{}};
 if(typeof lookupCurrentTarget!=="function"||
    typeof dispatchAgentOperation!=="function"||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)deny();
 return Object.freeze({
  async dispatch(rawEnvelope){
   const envelope=validateDshPlatformEnvelope(rawEnvelope);
   let current;
   try{current=validateDshPlatformTarget(await lookupCurrentTarget());}
   catch{audit("target_lookup_or_validation");deny();}
   if(current.deviceId!==trusted.deviceId){audit("device_identity_changed");deny();}
   let response;
   try{response=await dispatchAgentOperation(trusted.deviceId,envelope,{
     timeoutMs,maxBytes:262144,
   });}catch{audit("agent_dispatch_exception");deny();}
   if(!response||response.code!==0||response.truncated!==false||
      response.timedOut!==false||response.stderr!==""||
      typeof response.stdout!=="string"||response.stdout.length===0||
      Buffer.byteLength(response.stdout,"utf8")>262144){
    audit("agent_response_contract");deny();
   }
   let result;
   try{result=JSON.parse(response.stdout);}catch{audit("agent_response_json");deny();}
   if(!result||typeof result!=="object"){audit("agent_result_shape");deny();}
   // The downstream host MUST separately authenticate transport and enforce
   // managed root, replay, grants, and official DSH service authorization.
   return result;
  },
 });
}
