/**
 * Dedicated Draft LAB client: Remote-Ops OAuth+grants -> existing Agent Mesh
 * WSS dispatch -> separately authorized 28server Unix relay -> DSH mTLS.
 *
 * This never changes the fixed HTTPS client, does not enable any tool, and
 * cannot target the existing read-only deepharness-read profile. The target
 * comes from the trusted server registry, never a ChatGPT tool argument.
 */
import {makeDshAgentMeshEnvelope} from "./agent-mesh-contract.mjs";
import {createDshPrivateBridgeClient} from "./private-bridge-client.mjs";

const TARGET_ID="deepharness-semantic-lab";
const CAPABILITY="deepharness.semantic";
const MAX_RESULT_BYTES=262_144;
const DEVICE=/^dev_[A-Za-z0-9_-]{8,80}$/;
const deny=()=>{throw Error("deepharness_agent_mesh_client_unavailable");};
const arrayEmpty=value=>value===undefined||(Array.isArray(value)&&value.length===0);

export function validateDshSemanticAgentTarget(target) {
  if(!target||typeof target!=="object"||Array.isArray(target)||
     target.id!==TARGET_ID||target.transport!=="agent"||
     target.environment!=="development"||
     target.capabilityProfile!=="semantic-operator"||
     target.enabled!==true||typeof target.deviceId!=="string"||
     !DEVICE.test(target.deviceId)||
     !Array.isArray(target.allowedSemanticCapabilities)||
     target.allowedSemanticCapabilities.length!==1||
     target.allowedSemanticCapabilities[0]!==CAPABILITY||
     ![
       "allowedPaths","allowedGitRepos",
       "allowedDockerContainers","allowedDockerExecContainers",
       "allowedDockerExecPrograms","allowedDockerActions","allowedDockerImageLoadRoots",
       "allowedDockerCandidateImagePrefixes","allowedDockerCandidateNetworks",
       "allowedDockerCandidateNamePrefixes","allowedDockerCandidateHostPorts",
       "allowedDockerCandidateContainerPorts","allowedServices","allowedServiceActions",
       "allowedAdminPrograms","allowedAdminCwds","allowedWritePaths",
       "allowedProcessCwds","allowedProcessPrograms",
     ].every(key=>arrayEmpty(target[key])))deny();
  return Object.freeze({id:TARGET_ID,deviceId:target.deviceId});
}

export function createDshAgentMeshSemanticRequester({
  target,dispatchAgentOperation,timeoutMs=10_000,
}={}) {
  const trusted=validateDshSemanticAgentTarget(target);
  if(typeof dispatchAgentOperation!=="function"||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30_000)deny();
  return async function postJson(payload) {
    const envelope=makeDshAgentMeshEnvelope(payload);
    let response;
    try{
      response=await dispatchAgentOperation(trusted.deviceId,envelope,{
        timeoutMs,maxBytes:MAX_RESULT_BYTES,
      });
    }catch{deny();}
    if(!response||typeof response!=="object"||response.code!==0||
       response.truncated!==false||response.timedOut!==false||
       response.stderr!==""||typeof response.stdout!=="string"||
       Buffer.byteLength(response.stdout,"utf8")>MAX_RESULT_BYTES||
       response.stdout.length===0)deny();
    try {
      return JSON.parse(response.stdout);
    }catch{deny();}
  };
}

/** Reuse the already-reviewed fixed five-operation private bridge API. */
export function createDshPrivateBridgeClientOverAgentMesh(deps={}) {
  const postJson=createDshAgentMeshSemanticRequester(deps);
  return createDshPrivateBridgeClient({postJson});
}
