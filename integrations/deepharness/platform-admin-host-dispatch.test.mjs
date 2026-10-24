import test from "node:test";
import assert from "node:assert/strict";
import {createDshPlatformHostDispatcher} from "./platform-admin-host-dispatch.mjs";
import {makeDshPlatformEnvelope} from "./platform-admin-contract.mjs";
const KEY="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const W="fc24d43c-caf3-4059-8d82-5e9edd3c04c8";
const L="session-83cba7de-20a3-447b-967a-36315132db1a";
const denied=/deepharness_platform_(?:host_unavailable|contract_denied)/;
function fixture(){
  const calls=[];
  const admin={
    listWorkspaces:async()=>[{workspaceId:W,title:"Workspace A"}],
    createWorkspace:async args=>{calls.push(["createWorkspace",args]);return {created:true,workspace:{workspaceId:W,title:args.title}};},
    renameWorkspace:async args=>{calls.push(["renameWorkspace",args]);return {workspaceId:args.workspaceId,title:args.title};},
    listWorkspaceSessions:async args=>{calls.push(["listWorkspaceSessions",args]);return [L];},
    listTeamMemberStates:async args=>{calls.push(["listTeamMemberStates",args]);return {workspaceId:args.workspaceId,leadSessionId:args.leadSessionId,members:[]};},
    createLeadSession:async args=>{calls.push(["createLeadSession",args]);return {workspaceId:args.workspaceId,leadSessionId:L};},
    createTeammate:async args=>{calls.push(["createTeammate",args]);return {member:{id:L,name:args.name}};},
    createTeamTask:async args=>{calls.push(["createTeamTask",args]);return {taskId:"task-1",revision:1,status:"pending"};},
    updateTeamTask:async args=>{calls.push(["updateTeamTask",args]);return {taskId:args.taskId,revision:args.expectedRevision+1,status:"completed"};},
  };
  const duplicates=new Map();
  const gate=async(ctx,work)=>{
    const old=duplicates.get(ctx.requestId);
    if(old){
      if(old.payloadHash!==ctx.payloadHash||old.action!==ctx.action)throw Error("replay-mismatch");
      return {...old,duplicate:true};
    }
    const result=await work();
    const rec={...ctx,result,committed:true,duplicate:false};
    duplicates.set(ctx.requestId,rec);
    return rec;
  };
  return {dispatch:createDshPlatformHostDispatcher({admin,withDurableReplay:gate}).dispatch,calls,admin,gate};
}
test("requires complete host service surface and an independent replay gate",()=>{
  const {admin,gate}=fixture();
  assert.throws(()=>createDshPlatformHostDispatcher({}),denied);
  assert.throws(()=>createDshPlatformHostDispatcher({admin}),denied);
  assert.throws(()=>createDshPlatformHostDispatcher({
    admin:{...admin,createWorkspace:undefined},withDurableReplay:gate,
  }),denied);
});
test("all nine V2 routes have strict mapped business args with no requestId",async()=>{
  const f=fixture();
  const cases=[
    {operation:"listWorkspaces"},
    {operation:"createWorkspace",name:"mvp-b2b",title:"Marketplace",requestId:KEY},
    {operation:"renameWorkspace",workspaceId:W,title:"Marketplace",requestId:KEY},
    {operation:"listWorkspaceSessions",workspaceId:W},
    {operation:"listTeamMemberStates",workspaceId:W,leadSessionId:L},
    {operation:"createLeadSession",workspaceId:W,agentPreset:"default",requestId:KEY},
    {operation:"createTeammate",workspaceId:W,leadSessionId:L,name:"reviewer",
      description:"Review",prompt:"Review project",provider:"nvidia",context:"fresh",requestId:KEY},
    {operation:"createTeamTask",workspaceId:W,leadSessionId:L,subject:"Review",
      description:"Review code",requestId:KEY},
    {operation:"updateTeamTask",workspaceId:W,leadSessionId:L,taskId:"task-1",
      expectedRevision:1,action:"complete",owner:null,requestId:KEY},
  ];
  let n=0;
  for(const c of cases){
    // Distinct replay keys per operation, as expected from gateway principal
    // namespacing; never conflate separate mutations.
    const args={...c,...(c.requestId?{requestId:KEY.slice(0,8)+"-"+String(++n).padStart(4,"0")+"-4abc-9270-9715e3d34e38"}:{})};
    const result=await f.dispatch(makeDshPlatformEnvelope(args));
    assert.ok(result!==undefined);
  }
  const writes=f.calls.filter(x=>!["listWorkspaceSessions","listTeamMemberStates"].includes(x[0]));
  assert.equal(writes.length,6);
  for(const [method,args] of f.calls){
    assert.equal(typeof method,"string");assert.ok(!Object.hasOwn(args,"requestId"));
    assert.ok(!Object.hasOwn(args,"actor"));assert.ok(!Object.hasOwn(args,"url"));
  }
});
test("same request replay returns same result and invokes official mutation once",async()=>{
  const f=fixture(),a={operation:"createWorkspace",name:"mvp-b2b",title:"MVP",requestId:KEY};
  const x=await f.dispatch(makeDshPlatformEnvelope(a));
  const y=await f.dispatch(makeDshPlatformEnvelope(a));
  assert.deepEqual(x,y);
  assert.equal(f.calls.length,1);
  await assert.rejects(f.dispatch(makeDshPlatformEnvelope({...a,title:"Changed"})),/replay-mismatch/);
  assert.equal(f.calls.length,1);
});
test("invalid envelope, forged authority and unsupported operation never call host",async()=>{
  const f=fixture();
  for(const payload of [
    {op:"deepharness.platform",args:{operation:"listWorkspaces",actor:"root"}},
    {op:"deepharness.semantic",args:{operation:"listWorkspaces"}},
    {op:"deepharness.platform",args:{operation:"shell",command:"whoami"}},
    {op:"deepharness.platform",args:{operation:"createWorkspace",name:"../../root",title:"Bad",requestId:KEY}},
  ])await assert.rejects(f.dispatch(payload),denied);
  assert.equal(f.calls.length,0);
});
test("host gate cannot report false attestation or return a non-object write result",async()=>{
  const {admin}=fixture();
  const f=createDshPlatformHostDispatcher({
    admin,withDurableReplay:async(ctx,commit)=>({
      ...ctx,committed:false,duplicate:false,result:await commit(),
    }),
  });
  await assert.rejects(f.dispatch(makeDshPlatformEnvelope({
    operation:"createWorkspace",name:"mvp-b2b",title:"MVP",requestId:KEY,
  })),denied);
});
