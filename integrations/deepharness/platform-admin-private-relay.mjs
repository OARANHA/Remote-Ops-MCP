/**
 * Inert host-side V2 relay composition. The surrounding private AF_UNIX/mTLS
 * listener MUST authenticate its peer and supply that fact out of band.
 * No HTTP listener, route, target, OAuth principal, or tool is created here.
 */
import {createDshPlatformHostDispatcher} from "./platform-admin-host-dispatch.mjs";
import {validateDshPlatformEnvelope} from "./platform-admin-contract.mjs";
const deny=()=>{throw Error("deepharness_platform_private_relay_unavailable");};
const bounded=value=>{
 let json;
 try{json=JSON.stringify(value);}catch{deny();}
 if(typeof json!=="string"||Buffer.byteLength(json,"utf8")>262144)deny();
 let result;
 try{result=JSON.parse(json);}catch{deny();}
 if(!result||typeof result!=="object")deny();
 return result;
};
/**
 * authenticatePeer(connection) must be an independently configured transport
 * check (mTLS certificate/AF_UNIX peer credentials), never request JSON.
 * A durable host replay provider is mandatory for mutations. In particular,
 * no call may reach official DSH admin methods prior to replay admission.
 */
export function createDshPlatformPrivateRelay({
 admin,withDurableReplay,authenticatePeer,
}={}){
 if(typeof authenticatePeer!=="function"||
    typeof withDurableReplay!=="function")deny();
 const dispatcher=createDshPlatformHostDispatcher({admin,withDurableReplay});
 return Object.freeze({
  async dispatch(connection,envelope){
   // The connection is owned by the private listener, not sent by the model.
   // Revalidate on every call, including reads.
   let authenticated=false;
   try{authenticated=await authenticatePeer(connection)===true;}catch{deny();}
   if(!authenticated)deny();
   const request=validateDshPlatformEnvelope(envelope);
   const result=await dispatcher.dispatch(request);
   return bounded(result);
  },
 });
}
