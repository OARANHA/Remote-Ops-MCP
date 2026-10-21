import test from "node:test";
import assert from "node:assert/strict";
import {createDshPlatformToolDefs} from "./platform-admin-mcp-tools.mjs";
const KEY="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const principal={actor:"oauth:client:session-0123",clientId:"client",
  sessionId:"session-0123456789abcdef"};
test("eight optional tool definitions map only exact named DSH business actions",async()=>{
  const calls=[];
  const defs=createDshPlatformToolDefs({
    execute:async(auth,args)=>{calls.push({auth,args});return {ok:true}},
  });
  const expected=[
    "listWorkspaces","createWorkspace","renameWorkspace","listWorkspaceSessions",
    "createLeadSession","createTeammate","createTeamTask","updateTeamTask",
  ];
  assert.equal(defs.length,8);
  assert.equal(new Set(defs.map(d=>d.name)).size,8);
  assert.equal(defs[0].mutation,undefined);
  assert.equal(defs[3].mutation,undefined);
  assert.ok(defs.filter(d=>d.mutation).length===6);
  const minimal=[
    {},{name:"lab-new",title:"Lab New",requestId:KEY},
    {workspaceId:"lab-1",title:"Lab",requestId:KEY},
    {workspaceId:"lab-1"},
    {workspaceId:"lab-1",agentPreset:"default",requestId:KEY},
    {workspaceId:"lab-1",leadSessionId:"lead-1",name:"reviewer",
      description:"Review",prompt:"Inspect",provider:"nvidia",context:"fresh",requestId:KEY},
    {workspaceId:"lab-1",leadSessionId:"lead-1",subject:"Inspect",description:"Task",requestId:KEY},
    {workspaceId:"lab-1",leadSessionId:"lead-1",taskId:"task-1",
      expectedRevision:2,action:"complete",owner:null,requestId:KEY},
  ];
  for(let i=0;i<defs.length;i++){
    assert.deepEqual(await defs[i].run(minimal[i],principal),{ok:true});
    assert.deepEqual(calls[i].auth,principal);
    assert.deepEqual(calls[i].args,{operation:expected[i],...minimal[i]});
    assert.equal(Object.hasOwn(calls[i].args,"actor"),false);
  }
});
test("reject factory without authenticated policy adapter and absent MCP identity",async()=>{
  assert.throws(()=>createDshPlatformToolDefs({}),/unavailable/);
  const defs=createDshPlatformToolDefs({execute:async()=>true});
  await assert.rejects(defs[0].run({},null),/unavailable/);
});
