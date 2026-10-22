/**
 * V2 readiness contract: verifies concrete host-side dependencies before
 * any private listener can be composed. Readiness is not a deployment toggle.
 */
const deny=()=>{throw Error("deepharness_platform_host_not_ready");};
const METHODS=Object.freeze([
 "listWorkspaces","createWorkspace","renameWorkspace","listWorkspaceSessions",
 "createLeadSession","createTeammate","createTeamTask","updateTeamTask",
]);
export function assertDshPlatformHostReadiness({
 admin,authenticatePeer,replayFile,verifiedOfficialServices,
 exclusiveReplayWriter,privateTransportAuthenticated,
}={}){
 if(verifiedOfficialServices!==true||
    exclusiveReplayWriter!==true||
    privateTransportAuthenticated!==true||
    typeof authenticatePeer!=="function"||
    !admin||typeof admin!=="object"||Array.isArray(admin)||
    METHODS.some(method=>typeof admin[method]!=="function")||
    typeof replayFile!=="string"||!replayFile.startsWith("/")||
    replayFile.includes("\0")||replayFile.split("/").includes(".."))deny();
 return Object.freeze({ready:true,operations:[...METHODS]});
}
