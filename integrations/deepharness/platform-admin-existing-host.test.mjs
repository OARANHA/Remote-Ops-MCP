import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as host from './platform-admin-private-host.mjs';

const PIN=Array(32).fill('ab').join(':');
test('host readiness inspects official capabilities without a listener, grant or replay write',()=>{
 const f=fixture();
 try{
  assert.equal(typeof host.inspectDshPlatformExistingHostServices,'function');
  const report=host.inspectDshPlatformExistingHostServices(f.ctx);
  assert.equal(report.ready,true);assert.equal(report.directoryBrowse,true);
  assert.equal(f.writes(),0);assert.equal(existsSync(f.options.replayFile),false);
  f.ctx.sessionController={...f.ctx.sessionController,create:undefined};
  assert.equal(host.inspectDshPlatformExistingHostServices(f.ctx).ready,false);
  f.ctx.directoryPicker={capability:()=>{throw Error('unavailable');}};
  assert.equal(host.inspectDshPlatformExistingHostServices(f.ctx).directoryBrowse,false);
 }finally{f.dispose();}
});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'dsh-existing-host-'));
 const rows=new Map();let writes=0;
 const services={
  workspaceRegistry:{list:()=>[...rows.values()],get:id=>rows.get(id),resolveByPath:async p=>[...rows.values()].find(w=>w.path===p)},
  directoryPicker:{capability:()=>({kind:'browse'})},
  directoryPickerController:{createDirectory:async(p,n)=>{writes++;return join(p,n);}},
  workspaceController:{create:async({path})=>{const ws={id:'workspace-new',path,title:'new-lab',sessionIds:[]};
   rows.set(ws.id,ws);return {created:true,workspace:{workspaceId:ws.id,path,title:ws.title}};},
   rename:async({workspaceId,title})=>{rows.get(workspaceId).title=title;return {workspace:{workspaceId,title}};}},
  sessionController:{create:async()=>({sessionId:'lead-new'}),resolveAgent:async id=>({agent:{id}})},
  agentTeams:{spawnTeammate:async()=>({}),createTask:async()=>({}),updateTask:async()=>({})},
 };
 const effects=[];const readService={};
 const ctx={...services,get:name=>name==='chatgptMcpRead'?readService:undefined,effect:fn=>effects.push(fn)};
 const options={enabled:true,ctx,workspaceParent:root,replayFile:join(root,'replay.json'),
  allowedActions:['workspace.list','workspace.create'],clientFingerprintSha256:PIN,exclusiveReplayWriter:true};
 return {root,ctx,options,writes:()=>writes,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
async function invoke(handler,{socket={encrypted:true,authorized:true,getPeerCertificate:()=>({fingerprint256:PIN})},
 args={operation:'listWorkspaces'},extra={}}={}){
 const req=Readable.from([JSON.stringify({op:'deepharness.platform',args,...extra})]);
 Object.assign(req,{socket,method:'POST',url:'/wandora/dsh-platform/v2',headers:{'content-type':'application/json'}});
 const res={status:0,headersSent:false,payload:'',writeHead(code){this.status=code;this.headersSent=true;},end(body){this.payload=String(body);}};
 await handler.handle(req,res);return res;
}
test('existing host requires explicit local authority and concrete services before any listener',()=>{
 const f=fixture();
 try {
  assert.equal(typeof host.createDshPlatformExistingHostHandler,'function');
  for(const patch of [{enabled:false},{allowedActions:[]},{allowedActions:['shell']},
   {exclusiveReplayWriter:false},{clientFingerprintSha256:'bad'},
   {ctx:{...f.ctx,directoryPicker:{capability:()=>({kind:'native'})}}}])
   assert.throws(()=>host.createDshPlatformExistingHostHandler({...f.options,...patch}));
 } finally {f.dispose();}
});
test('existing host uses verified mTLS socket identity, ignores JSON authority and preserves durable replay',async()=>{
 const f=fixture();
 try {
  const handler=host.createDshPlatformExistingHostHandler(f.options);
  assert.equal((await invoke(handler)).status,200);
  for(const socket of [{},{encrypted:true,authorized:false},{encrypted:true,authorized:true,
   getPeerCertificate:()=>({fingerprint256:Array(32).fill('cd').join(':')})}]){
   assert.equal((await invoke(handler,{socket})).status,403);
  }
  const args={operation:'createWorkspace',name:'new-lab',title:'new-lab',requestId:randomUUID()};
  const first=await invoke(handler,{args});assert.equal(first.status,200);
  assert.equal((await invoke(handler,{args})).payload,first.payload);assert.equal(f.writes(),1);
  assert.equal((await invoke(handler,{args,extra:{authorized:true}})).status,403);
  assert.equal((await invoke(handler,{args:{operation:'listWorkspaceSessions',workspaceId:'workspace-new'}})).status,403);
  const registry=f.ctx.workspaceRegistry;f.ctx.workspaceRegistry={...registry};
  assert.equal((await invoke(handler)).status,403);f.ctx.workspaceRegistry=registry;
  handler.dispose();assert.equal((await invoke(handler)).status,403);
 } finally {f.dispose();}
});
