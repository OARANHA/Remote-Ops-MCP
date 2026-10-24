import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {composeDshPlatformPrivateHost} from "./platform-admin-private-host.mjs";

test('private host binds official Context services and refuses unavailable directory browsing',async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'dsh-official-bind-'));
 const rows=new Map();let mutations=0;
 const services={
  directoryPicker:{capability:()=>({kind:'browse'})},
  workspaceRegistry:{list:()=>[...rows.values()],get:id=>rows.get(id),
   resolveByPath:async p=>[...rows.values()].find(w=>w.path===p)},
  directoryPickerController:{createDirectory:async(p,n)=>{mutations++;return p+'/'+n;}},
  workspaceController:{
   create:async({path:p})=>{rows.set('workspace-new',{id:'workspace-new',path:p,title:'new',sessionIds:[]});
    return {created:true,workspace:{workspaceId:'workspace-new',path:p,title:'new'}};},
   rename:async({workspaceId,title})=>{rows.get(workspaceId).title=title;return {workspace:{workspaceId,title}};}},
  sessionController:{create:async({workspaceId})=>{rows.get(workspaceId).sessionIds.push('lead-new');return {sessionId:'lead-new'};},
   resolveAgent:async id=>({id,session:{}})},
  agentTeams:{spawnTeammate:async(a,x)=>({member:{id:'member-new',name:x.name,role:'teammate',phase:'active'}}),
   createTask:async()=>({id:'task-new',revision:1,status:'pending'}),
   updateTask:async(a,x)=>({id:x.taskId,revision:x.expectedRevision+1,status:'in_progress'})},
 };
 const calls=[];
 const options={services,workspaceParent:'/data/dsh/projetos',
  authorizeRead:async x=>{calls.push(x.operation);},
  withAuthorizedWrite:async(x,work)=>{calls.push(x.operation);return work();},
  replayFile:path.join(folder,'replay.json'),authenticatePeer:async c=>c==='trusted-peer',
  verifiedOfficialServices:true,exclusiveReplayWriter:true,privateTransportAuthenticated:true};
 try {
  const host=composeDshPlatformPrivateHost(options);
  const invoke=args=>host.dispatch('trusted-peer',{op:'deepharness.platform',args});
  await assert.rejects(host.dispatch('forged',{op:'deepharness.platform',args:{operation:'listWorkspaces'}}));
  const key=()=>randomUUID();
  const created=await invoke({operation:'createWorkspace',name:'new-lab',title:'New lab',requestId:key()});
  assert.equal(created.workspace.workspaceId,'workspace-new');assert.equal(mutations,1);
  assert.equal((await invoke({operation:'listWorkspaces'})).length,1);
  await invoke({operation:'renameWorkspace',workspaceId:'workspace-new',title:'Renamed',requestId:key()});
  await invoke({operation:'createLeadSession',workspaceId:'workspace-new',agentPreset:'standard',requestId:key()});
  assert.deepEqual(await invoke({operation:'listWorkspaceSessions',workspaceId:'workspace-new'}),['lead-new']);
  await invoke({operation:'createTeammate',workspaceId:'workspace-new',leadSessionId:'lead-new',
   name:'reviewer',description:'Review',prompt:'Inspect',provider:'nvidia',context:'fresh',requestId:key()});
  await invoke({operation:'createTeamTask',workspaceId:'workspace-new',leadSessionId:'lead-new',
   subject:'Inspect',description:'Read source',requestId:key()});
  await invoke({operation:'updateTeamTask',workspaceId:'workspace-new',leadSessionId:'lead-new',
   taskId:'task-new',expectedRevision:1,action:'claim',owner:null,requestId:key()});
  assert.equal(new Set(calls).size,8);
  for(const patch of [
   {services:{...services,directoryPicker:{capability:()=>({kind:'native'})}}},
   {services:{...services,agentTeams:{...services.agentTeams,spawnTeammate:undefined}}},
   {authorizeRead:undefined},{withAuthorizedWrite:undefined},
  ])assert.throws(()=>composeDshPlatformPrivateHost({...options,...patch}));
 } finally {rmSync(folder,{recursive:true,force:true});}
});

const ID="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const methods=["listWorkspaces","createWorkspace","renameWorkspace",
 "listWorkspaceSessions","createLeadSession","createTeammate",
 "createTeamTask","updateTeamTask"];
function fixtures(){
 const counts={createWorkspace:0,listWorkspaces:0};
 const admin=Object.fromEntries(methods.map(name=>[name,async()=>({ok:true})]));
 admin.createWorkspace=async()=>{counts.createWorkspace++;return {id:"new-managed"};};
 admin.listWorkspaces=async()=>{counts.listWorkspaces++;return [{id:"managed-one"}];};
 const folder=mkdtempSync(path.join(tmpdir(),"dsh-host-v2-"));
 const file=path.join(folder,"replay.json");
 const options={admin,replayFile:file,authenticatePeer:async c=>c===true,
  verifiedOfficialServices:true,exclusiveReplayWriter:true,
  privateTransportAuthenticated:true};
 return {counts,file,options,dispose:()=>rmSync(folder,{recursive:true,force:true})};
}
test("private host: denies unauthenticated calls and preserves array reads",async()=>{
 const f=fixtures();
 try{
  const host=composeDshPlatformPrivateHost(f.options);
  const envelope={op:"deepharness.platform",args:{operation:"listWorkspaces"}};
  await assert.rejects(host.dispatch(false,envelope),/private_relay_unavailable/);
  assert.equal(f.counts.listWorkspaces,0);
  assert.deepEqual(await host.dispatch(true,envelope),[{id:"managed-one"}]);
 }finally{f.dispose();}
});
test("private host: crash replay does not repeat committed workspace creation",async()=>{
 const f=fixtures();
 const envelope={op:"deepharness.platform",args:{operation:"createWorkspace",
  name:"managed-new",title:"Managed new",requestId:ID}};
 try{
  const host=composeDshPlatformPrivateHost(f.options);
  assert.deepEqual(await host.dispatch(true,envelope),{id:"new-managed"});
  assert.equal(f.counts.createWorkspace,1);
  const restarted=composeDshPlatformPrivateHost(f.options);
  assert.deepEqual(await restarted.dispatch(true,envelope),{id:"new-managed"});
  assert.equal(f.counts.createWorkspace,1);
  const stored=JSON.parse(readFileSync(f.file,"utf8"));
  assert.equal(stored.receipts[ID].status,"committed");
  const digest=createHash("sha256").update(JSON.stringify(envelope.args)).digest("hex");
  assert.equal(stored.receipts[ID].payloadHash,digest);
  await assert.rejects(restarted.dispatch(true,{...envelope,
   args:{...envelope.args,title:"A different name"}}),/replay_conflict/);
  assert.equal(f.counts.createWorkspace,1);
 }finally{f.dispose();}
});
test("private host: unknown mutation result stays pending across restart",async()=>{
 const f=fixtures();
 f.options.admin.createWorkspace=async()=>{
  f.counts.createWorkspace++;throw Error("uncertain_write");
 };
 const envelope={op:"deepharness.platform",args:{operation:"createWorkspace",
  name:"managed-new",title:"Managed new",requestId:ID}};
 try{
  const host=composeDshPlatformPrivateHost(f.options);
  await assert.rejects(host.dispatch(true,envelope),/uncertain_write/);
  const restarted=composeDshPlatformPrivateHost(f.options);
  await assert.rejects(restarted.dispatch(true,envelope),/replay_uncertain/);
  assert.equal(f.counts.createWorkspace,1);
  assert.equal(JSON.parse(readFileSync(f.file,"utf8")).receipts[ID].status,"pending");
 }finally{f.dispose();}
});
test("private host: absent official-service attestation denies composition",()=>{
 const f=fixtures();
 try{
  assert.throws(()=>composeDshPlatformPrivateHost({
   ...f.options,verifiedOfficialServices:false}),/host_not_ready/);
 }finally{f.dispose();}
});
