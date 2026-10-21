import test from "node:test";
import assert from "node:assert/strict";
import {makeDshAgentMeshEnvelope,validateDshAgentMeshEnvelope} from "./agent-mesh-contract.mjs";

const workspaceId="lab-1",leadSessionId="lead-1";
const requestId="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const denied=/deepharness_agent_mesh_contract_denied/;
test("only five exact DSH semantic operations can be represented; no transport is created",()=>{
  const permitted=[
    {operation:"listTeams",workspaceId},
    {operation:"getTeamStatus",workspaceId,leadSessionId},
    {operation:"listTasks",workspaceId,leadSessionId},
    {operation:"readLeadChat",workspaceId,leadSessionId,maxMessages:20},
    {operation:"sendLeadInstruction",workspaceId,leadSessionId,requestId,text:"synthetic only"},
  ];
  for(const args of permitted){
    const envelope=makeDshAgentMeshEnvelope(args);
    assert.equal(envelope.op,"deepharness.semantic");
    assert.deepEqual(envelope.args,args);
    assert.equal(Object.isFrozen(envelope),true);
    assert.equal(Object.isFrozen(envelope.args),true);
    assert.deepEqual(validateDshAgentMeshEnvelope(envelope),envelope);
  }
});
test("unknown operations, caller-chosen endpoints, OAuth credentials, grants and extra fields fail closed",()=>{
  const normal={operation:"listTeams",workspaceId};
  for(const args of [
    {...normal,operation:"shell"}, {...normal,operation:"docker.exec"},
    {...normal,operation:"sendLeadInstruction"}, {...normal,url:"https://example.com"},
    {...normal,hostname:"127.0.0.1"}, {...normal,port:3443},
    {...normal,grant:"all"}, {...normal,actor:"owner"},
    {...normal,oauthSessionId:"forged"}, {...normal,token:"secret"},
    {...normal,cmd:"ls"}, {...normal,target:"wandora-prod"},
    {...normal,action:"write"}, {...normal,requestId},
    {...normal,leadSessionId}, {...normal,workspaceId:""},
    {...normal,workspaceId:"../../other"}, {...normal,workspaceId:"x".repeat(129)},
  ])assert.throws(()=>makeDshAgentMeshEnvelope(args),denied);
  for(const envelope of [
    {op:"host.managed_admin",args:normal},
    {op:"deepharness.semantic",args:normal,timeoutMs:0},
    {op:"deepharness.semantic",args:null},null,
  ])assert.throws(()=>validateDshAgentMeshEnvelope(envelope),denied);
});
test("Lead, history and instruction bounds reject invalid or oversized payloads",()=>{
  for(const lead of ["","../etc/passwd","bad\nlead",null]){
    assert.throws(()=>makeDshAgentMeshEnvelope({operation:"getTeamStatus",workspaceId,leadSessionId:lead}),denied);
  }
  for(const maxMessages of [-1,0,1.5,21,"20",null]){
    assert.throws(()=>makeDshAgentMeshEnvelope({operation:"readLeadChat",workspaceId,leadSessionId,maxMessages}),denied);
  }
  for(const text of ["","  ","x".repeat(4097),"á".repeat(3000),"contains\0null",null]){
    assert.throws(()=>makeDshAgentMeshEnvelope({operation:"sendLeadInstruction",workspaceId,leadSessionId,requestId,text}),denied);
  }
  for(const request of ["bad",null,"12345678-0000-0000-0000-000000000000"]){
    assert.throws(()=>makeDshAgentMeshEnvelope({operation:"sendLeadInstruction",workspaceId,leadSessionId,requestId:request,text:"go"}),denied);
  }
});
test("detaches caller-owned args before future transport, preserving exact request identity",()=>{
  const args={operation:"sendLeadInstruction",workspaceId,leadSessionId,requestId,text:"synthetic"};
  const envelope=makeDshAgentMeshEnvelope(args);
  args.text="modified";
  assert.equal(envelope.args.text,"synthetic");
  assert.equal(envelope.args.requestId,requestId);
  assert.equal("hostname" in envelope,false);
  assert.equal("deviceId" in envelope,false);
});
