/**
 * Optional V2 host assembly. NO listener or tool registration.
 * The private transport passes an authenticated connection separately from
 * the user/model envelope. Durable replay remains on the DSH host only.
 */
import {createDshPlatformDurableReplay} from "./platform-admin-durable-replay.mjs";
import {createDshPlatformPrivateRelay} from "./platform-admin-private-relay.mjs";
import {createOfficialDshPlatformAdmin} from "./official-dsh-platform-admin.mjs";
import {assertDshPlatformHostReadiness} from "./platform-admin-host-readiness.mjs";

const deny=()=>{throw Error("deepharness_platform_host_composition_unavailable");};

/**
 * This factory must be constructed only inside the DSH private service.
 * replayFile must live on a durable, isolated, single-writer host volume.
 * authenticatePeer must validate the real mTLS or AF_UNIX peer credentials,
 * NOT a value supplied inside JSON. An absent dependency fails closed.
 */
export function composeDshPlatformPrivateHost({
 admin,services,workspaceParent,authorizeRead,withAuthorizedWrite,
 authenticatePeer,replayFile,verifiedOfficialServices,
 exclusiveReplayWriter,privateTransportAuthenticated,
}={}){
 // Bind the actual Cordis Context services; never emulate directory creation.
 // Host read/write authorization is mandatory and remains independent of the
 // OAuth gate in the gateway. No permissive callback is supplied here.
 if(services!==undefined){
  if(admin!==undefined||verifiedOfficialServices!==true||
     typeof services?.directoryPicker?.capability!=="function"||
     services.directoryPicker.capability()?.kind!=="browse"||
     typeof services?.agentTeams?.spawnTeammate!=="function")deny();
  admin=createOfficialDshPlatformAdmin({
   workspaceRegistry:services.workspaceRegistry,
   workspaceController:services.workspaceController,
   directoryPickerController:services.directoryPickerController,
   sessionController:services.sessionController,agentTeams:services.agentTeams,
   workspaceParent,authorizeRead,withAuthorizedWrite,
  });
 }
 assertDshPlatformHostReadiness({admin,authenticatePeer,replayFile,
  verifiedOfficialServices,exclusiveReplayWriter,privateTransportAuthenticated});
 const replay=createDshPlatformDurableReplay({file:replayFile});
 return createDshPlatformPrivateRelay({
  admin,authenticatePeer,
  withDurableReplay:(request,commit)=>
   replay.withDurableReplay(request,commit),
 });
}
