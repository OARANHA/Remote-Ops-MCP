import test from "node:test";
import assert from "node:assert/strict";
import {
  makeDshPlatformEnvelope,validateDshPlatformEnvelope,actionForDshPlatformOperation,
} from "./platform-admin-contract.mjs";
const K="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const W="fc24d43c-caf3-4059-8d82-5e9edd3c04c8";
const L="session-83cba7de-20a3-447b-967a-36315132db1a";
const deny=/deepharness_platform_contract_denied/;
const cases=[
  {operation:"listWorkspaces"},
  {operation:"createWorkspace",name:"new-project",title:"New Project",requestId:K},
  {operation:"renameWorkspace",workspaceId:W,title:"Renamed",requestId:K},
  {operation:"listWorkspaceSessions",workspaceId:W},
  {operation:"createLeadSession",workspaceId:W,agentPreset:"standard",requestId:K},
  {operation:"createTeammate",workspaceId:W,leadSessionId:L,name:"reviewer",
    description:"Review code",prompt:"Analyze and report",provider:"nvidia",context:"fresh",requestId:K},
  {operation:"createTeamTask",workspaceId:W,leadSessionId:L,subject:"Implement unit tests",
    description:"Analyze edge cases",requestId:K},
  {operation:"updateTeamTask",workspaceId:W,leadSessionId:L,taskId:"task-1",
    expectedRevision:1,action:"complete",owner:null,requestId:K},
  {operation:"listTeamMemberStates",workspaceId:W,leadSessionId:L},
];
test("nine exact operator verbs; no platform listener or grants enabled",()=>{
  const expected=["workspace.list","workspace.create","workspace.rename","session.list",
    "session.create","team.member.create","team.task.create","team.task.update","team.member.read"];
  for(let i=0;i<cases.length;i++){
    const req=cases[i];
    assert.equal(actionForDshPlatformOperation(req.operation),expected[i]);
    const e=makeDshPlatformEnvelope(req);
    assert.equal(e.op,"deepharness.platform");
    assert.deepEqual(e.args,req);
    assert.ok(Object.isFrozen(e)&&Object.isFrozen(e.args));
    assert.deepEqual(validateDshPlatformEnvelope(e),e);
  }
});
test("deny commands, arbitrary endpoints and privilege claims before routing",()=>{
  for(const injected of [
    {operation:"shell",command:"cat /etc/shadow"},
    {operation:"docker.exec",container:"root"},
    {operation:"listWorkspaces",scope:"all"},
    {operation:"listWorkspaces",actor:"oauth:forged"},
    {operation:"listWorkspaces",oauthSession:"forged"},
    {operation:"listWorkspaces",target:"wandora-prod"},
    {operation:"listWorkspaces",url:"http://evil"},
    {operation:"createWorkspace",name:"new-project",title:"Project",requestId:K,path:"/etc"},
    {operation:"createWorkspace",name:"../secrets",title:"Project",requestId:K},
    {operation:"createWorkspace",name:"./evil",title:"Project",requestId:K},
    {operation:"createWorkspace",name:"a/b",title:"Project",requestId:K},
    {operation:"createWorkspace",name:"Project",title:"Project",requestId:K},
    {operation:"createWorkspace",name:"new-project",title:"Project\nX",requestId:K},
    {operation:"createWorkspace",name:"new-project",title:"Project",requestId:"not-uuid"},
  ])assert.throws(()=>makeDshPlatformEnvelope(injected),deny);
  for(const e of [
    {op:"deepharness.semantic",args:cases[0]},
    {op:"host.managed_admin",args:cases[0]},
    {op:"deepharness.platform",args:cases[0],scope:"global"},
    {op:"deepharness.platform",args:null},
  ])assert.throws(()=>validateDshPlatformEnvelope(e),deny);
});
test("deny cross-workspace path and malformed or oversized session/team inputs",()=>{
  for(const arg of [
    {...cases[2],workspaceId:"../../etc"},
    {...cases[3],workspaceId:""},
    {...cases[4],agentPreset:"\r\nsteal"},
    {...cases[5],context:"admin"},
    {...cases[5],leadSessionId:"../other-lead"},
    {...cases[5],provider:"nvidia/model/../../secrets"},
    {...cases[5],prompt:"x".repeat(17000)},
    {...cases[6],description:"x".repeat(1600)},
    {...cases[7],action:"delete"},
    {...cases[7],expectedRevision:0},
    {...cases[7],action:"reassign"},
    {...cases[7],owner:"../../bad"},
    {...cases[7],requestId:"not-an-id"},
  ])assert.throws(()=>makeDshPlatformEnvelope(arg),deny);
});
test("snapshot detaches caller objects and size bounds apply to envelope",()=>{
  const data={...cases[6]};
  const envelope=makeDshPlatformEnvelope(data);
  data.subject="CHANGED";
  assert.equal(envelope.args.subject,"Implement unit tests");
  assert.ok(Buffer.byteLength(JSON.stringify(envelope))<=16384);
  assert.throws(()=>actionForDshPlatformOperation("owner.grant_root"),deny);
});

test("skill catalog uses exact session-bound read envelope and no arbitrary path",()=>{
 const good={operation:"listSessionSkills",workspaceId:W,sessionId:L};
 assert.equal(actionForDshPlatformOperation(good.operation),"skills.list");
 assert.deepEqual(makeDshPlatformEnvelope(good).args,good);
 for(const bad of [{...good,path:"/etc"}, {...good,sessionId:"../bad"}, {...good,oauthSession:"fake"}, {...good,workspaceId:""}]){
  assert.throws(()=>makeDshPlatformEnvelope(bad),deny);
 }
});
