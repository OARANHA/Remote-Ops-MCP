import test from "node:test";
import assert from "node:assert/strict";
import {assertDshPlatformHostReadiness} from "./platform-admin-host-readiness.mjs";
const methods=["listWorkspaces","createWorkspace","renameWorkspace",
 "listWorkspaceSessions","listTeamMemberStates","createLeadSession","createTeammate",
 "createTeamTask","updateTeamTask"];
const admin=Object.fromEntries(methods.map(name=>[name,async()=>({})]));
const good={admin,authenticatePeer:async()=>true,replayFile:"/private/dsh-v2-replay.json",
 verifiedOfficialServices:true,exclusiveReplayWriter:true,
 privateTransportAuthenticated:true};
test("host readiness denies absent or unverified dependencies",()=>{
 for(const key of Object.keys(good)){
  const candidate={...good};delete candidate[key];
  assert.throws(()=>assertDshPlatformHostReadiness(candidate),/not_ready/);
 }
 assert.throws(()=>assertDshPlatformHostReadiness({
  ...good,admin:{...admin,createTeamTask:undefined}}),/not_ready/);
 assert.throws(()=>assertDshPlatformHostReadiness({
  ...good,replayFile:"/private/../etc/replay"}),/not_ready/);
});
test("readiness success is a structural contract, not an active listener",()=>{
 const result=assertDshPlatformHostReadiness(good);
 assert.equal(result.ready,true);
 assert.deepEqual(result.operations,methods);
});
