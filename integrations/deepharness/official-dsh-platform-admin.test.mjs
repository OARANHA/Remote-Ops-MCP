import test from "node:test";
import assert from "node:assert/strict";
import {createOfficialDshPlatformAdmin} from "./official-dsh-platform-admin.mjs";

const ROOT="/data/dsh/projetos";
const lead="session-83cba7de-20a3-447b-967a-36315132db1a";
const W="fc24d43c-caf3-4059-8d82-5e9edd3c04c8";
const FORBIDDEN="7cfcdad5-61ea-435a-84da-cb9bce509209";
const denied=/dsh_platform_admin_denied/;
function fixture(){
  const rows=new Map([
    [W,{id:W,path:ROOT+"/lab",title:"lab",sessionIds:[lead],createdAt:"2026-10-21"}],
    [FORBIDDEN,{id:FORBIDDEN,path:"/opt/other",title:"other",sessionIds:[lead]}],
  ]);
  const calls=[],grants=new Set(["workspace.list","workspace.create","workspace.rename",
    "session.create","session.list","team.member.create","team.task.create","team.task.update"]);
  const env={
    workspaceParent:ROOT,
    authorizeRead:async ctx=>{if(!grants.has(ctx.operation))throw Error("revoked");},
    withAuthorizedWrite:async(ctx,work)=>{
      if(!grants.has(ctx.operation))throw Error("revoked");
      calls.push(["grant",ctx.operation]);
      return work();
    },
    workspaceRegistry:{
      list:()=>[...rows.values()],get:id=>rows.get(id),
      resolveByPath:async path=>[...rows.values()].find(x=>x.path===path),
    },
    directoryPickerController:{createDirectory:async(root,name)=>{
      calls.push(["mkdir",root,name]);return root+"/"+name;
    }},
    workspaceController:{
      create:async({path})=>{
        const id="bd037d3e-ac18-44a7-bc25-0bbcc5a8be1d";
        const title=path.split("/").at(-1);
        rows.set(id,{id,path,title,sessionIds:[]});
        return {created:true,workspace:{workspaceId:id,path,title}};
      },
      rename:async({workspaceId,title})=>{
        rows.get(workspaceId).title=title;
        return {workspace:{workspaceId,title}};
      },
    },
    sessionController:{
      create:async({workspaceId})=>{
        const id="session-99999999-9999-4999-8999-999999999999";
        rows.get(workspaceId).sessionIds.unshift(id);return {sessionId:id};
      },
      resolveAgent:async id=>({id,session:{}}),
    },
    agentTeams:{
      spawnTeammate:async(agent,input)=>{
        calls.push(["spawn",agent.id,input.name]);
        return {member:{id:"session-new-teammate",name:input.name,role:"teammate",phase:"active"}};
      },

      createTask:async(agent,task)=>{
        calls.push(["task",agent.id,task.subject]);
        return {id:"task-1",revision:1,status:"pending"};
      },
      updateTask:async(agent,change)=>{
        calls.push(["update",agent.id,change.action]);
        return {id:change.taskId,revision:change.expectedRevision+1,status:"completed"};
      },
    },
  };
  return {api:createOfficialDshPlatformAdmin(env),env,calls,rows,grants};
}
test("No trusted grant, workspace or host service denies construction",()=>{
  const {env}=fixture();
  for(const field of ["workspaceRegistry","workspaceController","directoryPickerController",
    "sessionController","agentTeams","authorizeRead","withAuthorizedWrite"]){
    assert.throws(()=>createOfficialDshPlatformAdmin({...env,[field]:undefined}),denied);
  }
  assert.throws(()=>createOfficialDshPlatformAdmin({...env,workspaceParent:"/"}),denied);
  assert.throws(()=>createOfficialDshPlatformAdmin({...env,workspaceParent:"/data/dsh/projetos/../secrets"}),denied);
});
test("List only permitted workspace directory without path or session ID leakage",async()=>{
  const {api}=fixture();
  const list=await api.listWorkspaces();
  assert.equal(list.length,1);
  assert.deepEqual(Object.keys(list[0]),["workspaceId","title","sessionCount","createdAt","updatedAt"]);
  assert.equal(list[0].sessionCount,1);
  assert.ok(Object.isFrozen(list));
  assert.ok(!JSON.stringify(list).includes(lead));
  assert.ok(!JSON.stringify(list).includes("/opt/other"));
});
test("Workspace creation uses official directory and registry, retries do not duplicate",async()=>{
  const {api,calls}=fixture();
  const first=await api.createWorkspace({name:"marketplace-b2b",title:"Marketplace B2B"});
  assert.equal(first.created,true);assert.equal(first.workspace.title,"Marketplace B2B");
  const retry=await api.createWorkspace({name:"marketplace-b2b",title:"Marketplace B2B"});
  assert.equal(retry.created,false);assert.equal(calls.filter(x=>x[0]==="mkdir").length,1);
  await assert.rejects(api.createWorkspace({name:"marketplace-b2b",title:"Other"}),denied);
});
test("Reject path traversal, extra parameters, control characters and wrong scope",async()=>{
  const {api,calls}=fixture();
  for(const name of ["../etc","../other","bad/name","bad\\name",".","UPPER","a","a".repeat(49)]){
    await assert.rejects(api.createWorkspace({name,title:"safe"}),denied);
  }
  await assert.rejects(api.createWorkspace({name:"safe",title:"one",path:"/etc"}),denied);
  await assert.rejects(api.createWorkspace({name:"safe",title:"bad\nTitle"}),denied);
  await assert.rejects(api.renameWorkspace({workspaceId:FORBIDDEN,title:"New"}),denied);
  await assert.rejects(api.createLeadSession({workspaceId:FORBIDDEN,agentPreset:"standard"}),denied);
  assert.equal(calls.filter(x=>x[0]==="mkdir").length,0);
});
test("Lead Session create uses DSH official SessionController with scoped Workspace",async()=>{
  const {api}=fixture();
  const created=await api.createLeadSession({workspaceId:W,agentPreset:"standard"});
  assert.deepEqual(created,{workspaceId:W,leadSessionId:"session-99999999-9999-4999-8999-999999999999"});
});
test("Team task create and update use verified Lead Agent and compare-and-set revision",async()=>{
  const {api,calls}=fixture();
  const created=await api.createTeamTask({workspaceId:W,leadSessionId:lead,
    subject:"Test idempotency",description:"Automated CI test"});
  assert.deepEqual(created,{taskId:"task-1",revision:1,status:"pending"});
  const changed=await api.updateTeamTask({workspaceId:W,leadSessionId:lead,
    taskId:"task-1",expectedRevision:1,action:"complete",owner:null});
  assert.deepEqual(changed,{taskId:"task-1",revision:2,status:"completed"});
  assert.equal(calls.filter(x=>x[0]==="task").length,1);
  assert.equal(calls.filter(x=>x[0]==="update").length,1);
});
test("Refuse unauthorized Lead and arbitrary delete/shell actions",async()=>{
  const {api}=fixture();
  await assert.rejects(api.createTeamTask({workspaceId:W,leadSessionId:"lead-another",
    subject:"Task",description:"Task"}),denied);
  const args={workspaceId:W,leadSessionId:lead,taskId:"task-1",
    expectedRevision:1,action:"delete",owner:null};
  await assert.rejects(api.updateTeamTask(args),denied);
  await assert.rejects(api.updateTeamTask({...args,action:"reassign"}),denied);
  await assert.rejects(api.updateTeamTask({...args,action:"complete",expectedRevision:0}),denied);
});
test("Revoked action fails before mutation or read",async()=>{
  const {api,grants,calls}=fixture();
  grants.delete("workspace.create");
  await assert.rejects(api.createWorkspace({name:"new-space",title:"New"}),/revoked/);
  assert.equal(calls.filter(x=>x[0]==="mkdir").length,0);
  grants.delete("workspace.list");
  await assert.rejects(api.listWorkspaces(),/revoked/);
});

test("Workspace session inventory and official teammate spawn obey scoped Lead",async()=>{
  const {api,calls}=fixture();
  assert.deepEqual(await api.listWorkspaceSessions({workspaceId:W}),[lead]);
  const x=await api.createTeammate({workspaceId:W,leadSessionId:lead,
    name:"revisor2",description:"Review design",prompt:"Review security risks",
    provider:"nvidia",context:"fresh"});
  assert.equal(x.member.name,"revisor2");
  assert.equal(calls.filter(x=>x[0]==="spawn").length,1);
  assert.deepEqual(calls.find(x=>x[0]==="spawn"),["spawn",lead,"revisor2"]);
  await assert.rejects(api.createTeammate({workspaceId:W,leadSessionId:lead,
    name:"too-long",description:"D".repeat(201),prompt:"Inspect",provider:"chutes.ai",context:"fresh"}),denied);
  await assert.rejects(api.createTeammate({workspaceId:W,leadSessionId:"other",
    name:"bad",description:"Bad",prompt:"Attempt",provider:"nvidia",context:"fresh"}),denied);
  await assert.rejects(api.createTeammate({workspaceId:W,leadSessionId:lead,
    name:"bad",description:"Bad",prompt:"Attempt",provider:"nvidia",context:"exploit"}),denied);
  await assert.rejects(api.listWorkspaceSessions({workspaceId:FORBIDDEN}),denied);
});

test("Optional official session skill catalog stays scoped and read-only",async()=>{
  const {env}=fixture();
  const calls=[];
  const api=createOfficialDshPlatformAdmin({...env,
    authorizeRead:async scope=>{calls.push(scope.operation);if(scope.operation!=="skills.list")throw Error("revoked");},
    sessionSkillCatalog:{list:async request=>{
      assert.deepEqual(request,{sessionId:lead});
      return {skills:[{name:"skill-one",description:"Example",modelInvocable:false}]};
    }},
  });
  const result=await api.listSessionSkills({workspaceId:W,sessionId:lead});
  assert.equal(result.skills[0].name,"skill-one");
  assert.equal(result.cleanupAuthorized,false);
  assert.equal(result.projectRootsComplete,false);
  assert.deepEqual(calls,["skills.list","skills.list"]);
  await assert.rejects(api.listSessionSkills({workspaceId:FORBIDDEN,sessionId:lead}),denied);
  await assert.rejects(api.listSessionSkills({workspaceId:W,sessionId:"unattached"}),denied);
  await assert.rejects(api.listSessionSkills({workspaceId:W,sessionId:lead,path:"/etc"}),denied);
});
test("Missing official skill service cannot advertise session skills",()=>{
 const {api}=fixture();
 assert.equal(api.listSessionSkills,undefined);
});

test("Teammate failures emit only allowlisted diagnostic stage without changing denial",async()=>{
  const {env}=fixture();
  const events=[];
  const input={workspaceId:W,leadSessionId:lead,name:"reviewer",
    description:"Review design",prompt:"PRIVATE_PROMPT_NEVER_LOG",
    provider:"nvidia",context:"fresh"};
  const api=createOfficialDshPlatformAdmin({...env,auditStage:event=>events.push(event),
    sessionController:{...env.sessionController,resolveAgent:async()=>{throw Error("PRIVATE_RESOLVE_ERROR");}}});
  await assert.rejects(api.createTeammate(input),/PRIVATE_RESOLVE_ERROR/);
  assert.deepEqual(events,[{operation:"team.member.create",stage:"resolve_agent"}]);
  events.length=0;
  const failing=createOfficialDshPlatformAdmin({...env,auditStage:event=>events.push(event),
    agentTeams:{...env.agentTeams,spawnTeammate:async()=>{throw Error("PRIVATE_SPAWN_ERROR");}}});
  await assert.rejects(failing.createTeammate(input),/PRIVATE_SPAWN_ERROR/);
  assert.deepEqual(events,[{operation:"team.member.create",stage:"spawn_teammate"}]);
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
});
