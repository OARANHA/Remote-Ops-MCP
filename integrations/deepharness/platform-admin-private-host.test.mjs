import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {composeDshPlatformPrivateHost} from "./platform-admin-private-host.mjs";

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
