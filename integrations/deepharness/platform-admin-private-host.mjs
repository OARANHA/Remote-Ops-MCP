/**
 * Optional V2 host assembly. NO listener or tool registration.
 * The private transport passes an authenticated connection separately from
 * the user/model envelope. Durable replay remains on the DSH host only.
 */
import {createDshPlatformDurableReplay} from "./platform-admin-durable-replay.mjs";
import {createDshPlatformPrivateRelay} from "./platform-admin-private-relay.mjs";
import {assertDshPlatformHostReadiness} from "./platform-admin-host-readiness.mjs";

const deny=()=>{throw Error("deepharness_platform_host_composition_unavailable");};

/**
 * This factory must be constructed only inside the DSH private service.
 * replayFile must live on a durable, isolated, single-writer host volume.
 * authenticatePeer must validate the real mTLS or AF_UNIX peer credentials,
 * NOT a value supplied inside JSON. An absent dependency fails closed.
 */
export function composeDshPlatformPrivateHost({
 admin,authenticatePeer,replayFile,verifiedOfficialServices,
 exclusiveReplayWriter,privateTransportAuthenticated,
}={}){
 assertDshPlatformHostReadiness({admin,authenticatePeer,replayFile,
  verifiedOfficialServices,exclusiveReplayWriter,privateTransportAuthenticated});
 const replay=createDshPlatformDurableReplay({file:replayFile});
 return createDshPlatformPrivateRelay({
  admin,authenticatePeer,
  withDurableReplay:(request,commit)=>
   replay.withDurableReplay(request,commit),
 });
}
