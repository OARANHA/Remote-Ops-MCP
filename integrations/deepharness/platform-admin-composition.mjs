/**
 * Draft V2 composition: authenticated OAuth principal -> persistent V2 grant
 * gate -> isolated private Agent Mesh dispatch. NOT an MCP registration.
 * This does not implement the DSH host relay or its independent durable replay.
 */
import {createDshPlatformPolicy} from "./platform-admin-policy.mjs";
import {createDshPlatformAgentMeshDispatcher} from "./platform-admin-agent-mesh-client.mjs";

const deny=()=>{throw Error("deepharness_platform_composition_unavailable");};
export function composeDshPlatformOverAgentMesh({
 grantStore,target,lookupCurrentTarget,dispatchAgentOperation,auditFailure,
}={}){
 if(typeof grantStore?.lookupCurrentGrant!=="function"||
    typeof grantStore?.withAuthorizedWrite!=="function")deny();
 const privateBridge=createDshPlatformAgentMeshDispatcher({
  target,lookupCurrentTarget,dispatchAgentOperation,auditFailure,
 });
 // The grant store serializes grant revocation against a write transaction.
 // The private backend MUST still implement independent host-side replay before
 // forwarding exact business parameters to the official DSH service.
 return createDshPlatformPolicy({
  lookupCurrentGrant:principal=>grantStore.lookupCurrentGrant(principal),
  withAuthorizedWrite:(context,submit)=>
   grantStore.withAuthorizedWrite(context,submit),
  dispatchEnvelope:envelope=>privateBridge.dispatch(envelope),
 });
}
