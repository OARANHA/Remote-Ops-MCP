import test from "node:test";
import assert from "node:assert/strict";
import {createDeepharnessToolDefs,loadDeepharnessToolDefs} from "./mcp-tools.mjs";

const ctx={actor:"oauth:client-1:session-1234",clientId:"client-1",sessionId:"session-123456"};
function fixture(){
  const calls=[];
  const policy={
    listTeams:async(caller,args)=>{calls.push(["listTeams",caller,args]);return [{leadSessionId:"lead-1"}];},
    readTeam:async(caller,args)=>{calls.push(["readTeam",caller,args]);return {tasks:[{id:"task-1"}]};},
    readChat:async(caller,args)=>{calls.push(["readChat",caller,args]);return {messages:[]};},
    sendLeadInstruction:async(caller,args)=>{calls.push(["send",caller,args]);return {accepted:true,receipt_id:"receipt_1"};},
  };
  return {calls,defs:createDeepharnessToolDefs(policy)};
}

test("registers the five semantic tools with explicit mutation and idempotency annotations",()=>{
  const {defs}=fixture();
  assert.deepEqual(defs.map(tool=>tool.name),["dsh_list_teams","dsh_get_team_status","dsh_list_tasks",
    "dsh_read_lead_chat","dsh_send_lead_instruction"]);
  assert.equal(defs[4].mutation,true);assert.equal(defs[4].idempotent,true);
  assert.equal(defs.slice(0,4).some(tool=>tool.mutation===true),false);
});

test("semantic tools remain absent unless the dedicated operator switch is exactly enabled",async()=>{
  const previous=process.env.DSH_SEMANTIC_ENABLED;
  delete process.env.DSH_SEMANTIC_ENABLED;
  try{assert.deepEqual(await loadDeepharnessToolDefs(),[]);}
  finally{if(previous===undefined)delete process.env.DSH_SEMANTIC_ENABLED;else process.env.DSH_SEMANTIC_ENABLED=previous;}
});

test("dispatches only verified caller context and exact requested scope",async()=>{
  const {calls,defs}=fixture();
  await defs[0].run({workspaceId:"workspace-1"},ctx);
  await defs[1].run({workspaceId:"workspace-1",leadSessionId:"lead-1"},ctx);
  await defs[2].run({workspaceId:"workspace-1",leadSessionId:"lead-1"},ctx);
  await defs[3].run({workspaceId:"workspace-1",leadSessionId:"lead-1",maxMessages:5},ctx);
  await defs[4].run({workspaceId:"workspace-1",leadSessionId:"lead-1",instruction:"Read the lab output",
    idempotencyKey:"4db3b83c-5abc-4aa3-9270-9715e3d34e38"},ctx);
  assert.deepEqual(calls.map(call=>call[0]),["listTeams","readTeam","readTeam","readChat","send"]);
  assert.deepEqual(calls[0][1],ctx);
  assert.equal(calls[4][2].instruction,"Read the lab output");
});
