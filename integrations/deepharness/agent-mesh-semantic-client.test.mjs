import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDshSemanticAgentTarget,createDshAgentMeshSemanticRequester,
  createDshPrivateBridgeClientOverAgentMesh,
} from "./agent-mesh-semantic-client.mjs";

const target={
  id:"deepharness-semantic-lab",transport:"agent",environment:"development",
  capabilityProfile:"semantic-operator",enabled:true,
  deviceId:"dev_lab_agent_12345678",allowedSemanticCapabilities:["deepharness.semantic"],
};
const uuid="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const noAccess=/deepharness_agent_mesh_client_unavailable/;
function ok(result){return {
  code:0,stdout:JSON.stringify(result),stderr:"",durationMs:1,
  truncated:false,timedOut:false,
};}
test("only a separate fixed named development semantic Agent Mesh target qualifies",()=>{
  assert.deepEqual(validateDshSemanticAgentTarget(target),{
    id:"deepharness-semantic-lab",deviceId:"dev_lab_agent_12345678",
  });
  const bad=[
    {...target,id:"deepharness-read"},
    {...target,id:"wandora-prod"},
    {...target,transport:"ssh"},
    {...target,environment:"production"},
    {...target,environment:"staging"},
    {...target,capabilityProfile:"read-only"},
    {...target,capabilityProfile:"operator"},
    {...target,enabled:false},
    {...target,deviceId:""},
    {...target,deviceId:"dev_tiny"},
    {...target,allowedSemanticCapabilities:[]},
    {...target,allowedSemanticCapabilities:["deepharness.semantic","host.managed_admin"]},
    {...target,allowedSemanticCapabilities:["host.status"]},
    {...target,allowedDockerContainers:["*"]},
    {...target,allowedWritePaths:["/tmp"]},
    {...target,allowedProcessPrograms:["node"]},
    {...target,allowedServices:["docker"]},
    {...target,allowedGitRepos:["OARANHA/deepharness"]},
    {...target,allowedPaths:["/etc"]},
    null,
  ];
  for(const x of bad)assert.throws(()=>validateDshSemanticAgentTarget(x),noAccess);
});
test("five bounded operations dispatch on the exact trusted device with no OAuth credentials",async()=>{
  const calls=[];
  const client=createDshPrivateBridgeClientOverAgentMesh({target,lookupCurrentTarget:()=>target,
    async dispatchAgentOperation(deviceId,envelope,opts){
      calls.push({deviceId,envelope,opts});
      const args=envelope.args;
      assert.equal(envelope.op,"deepharness.semantic");
      assert.deepEqual(Object.keys(envelope),["op","args"]);
      assert.equal(deviceId,target.deviceId);
      assert.equal(opts.timeoutMs,10000);
      assert.equal(opts.maxBytes,262144);
      assert.equal("actor" in args,false);
      assert.equal("clientId" in args,false);
      assert.equal("token" in args,false);
      assert.equal("hostname" in args,false);
      if(args.operation==="listTeams")return ok([{leadSessionId:"lead-1"}]);
      if(args.operation==="getTeamStatus")return ok({leadSessionId:"lead-1"});
      if(args.operation==="listTasks")return ok([{id:"t-1"}]);
      if(args.operation==="readLeadChat")return ok({messages:[],hasMore:false});
      return ok({accepted:true,requestId:args.requestId});
    },
  });
  assert.deepEqual(await client.listTeams({workspaceId:"lab-1"}),[{leadSessionId:"lead-1"}]);
  assert.deepEqual(await client.getTeamStatus({workspaceId:"lab-1",leadSessionId:"lead-1"}),{leadSessionId:"lead-1"});
  assert.deepEqual(await client.listTasks({workspaceId:"lab-1",leadSessionId:"lead-1"}),[{id:"t-1"}]);
  assert.deepEqual(await client.readLeadChat({workspaceId:"lab-1",leadSessionId:"lead-1",maxMessages:20}),{messages:[],hasMore:false});
  assert.deepEqual(await client.sendLeadInstruction({
    workspaceId:"lab-1",leadSessionId:"lead-1",requestId:uuid,text:"synthetic test only",
  }),{accepted:true,requestId:uuid});
  assert.deepEqual(calls.map(x=>x.envelope.args.operation),[
    "listTeams","getTeamStatus","listTasks","readLeadChat","sendLeadInstruction",
  ]);
  assert.deepEqual(calls[4].envelope.args,{
    operation:"sendLeadInstruction",workspaceId:"lab-1",
    leadSessionId:"lead-1",requestId:uuid,text:"synthetic test only",
  });
});
test("reject malformed, overbroad, untrusted semantic envelopes before remote dispatch",async()=>{
  let dispatched=0;
  const post=createDshAgentMeshSemanticRequester({target,lookupCurrentTarget:()=>target,
    async dispatchAgentOperation(){dispatched++;return ok([]);},
  });
  for(const arg of [
    {operation:"shell",workspaceId:"lab-1"},
    {operation:"listTeams",workspaceId:"lab-1",target:"deepharness-read"},
    {operation:"listTeams",workspaceId:"../etc"},
    {operation:"readLeadChat",workspaceId:"lab-1",leadSessionId:"lead-1",maxMessages:200},
    {operation:"sendLeadInstruction",workspaceId:"lab-1",leadSessionId:"lead-1",
      requestId:uuid,text:"x".repeat(4097)},
  ])await assert.rejects(post(arg),/deepharness_agent_mesh_contract_denied/);
  assert.equal(dispatched,0);
});
test("Agent Mesh offline, denied, timeout, oversized, malformed or truncated replies fail closed",async()=>{
  const input={operation:"listTeams",workspaceId:"lab-1"};
  const bad=[
    ()=>{throw Error("private agent token should never be logged");},
    ()=>({code:1,stdout:"[]",stderr:"private details",durationMs:1,truncated:false,timedOut:false}),
    ()=>({code:0,stdout:"[]",stderr:"",durationMs:1,truncated:true,timedOut:false}),
    ()=>({code:0,stdout:"[]",stderr:"",durationMs:1,truncated:false,timedOut:true}),
    ()=>({code:0,stdout:"not-json",stderr:"",durationMs:1,truncated:false,timedOut:false}),
    ()=>({code:0,stdout:"",stderr:"",durationMs:1,truncated:false,timedOut:false}),
    ()=>({...ok([]),stdout:"x".repeat(262145)}),
    ()=>null,
  ];
  for(const action of bad){
    const post=createDshAgentMeshSemanticRequester({
      target,lookupCurrentTarget:()=>target,async dispatchAgentOperation(){return action();},
    });
    await assert.rejects(post(input),noAccess);
  }
  assert.throws(()=>createDshAgentMeshSemanticRequester({
    target,lookupCurrentTarget:()=>target,dispatchAgentOperation:async()=>ok([]),timeoutMs:120000,
  }),noAccess);
});

test("disabled or reassigned semantic lab target is rejected at dispatch time",async()=>{
  let current=target,dispatched=0;
  const post=createDshAgentMeshSemanticRequester({
    target,lookupCurrentTarget:()=>current,
    dispatchAgentOperation:async()=>{dispatched++;return ok([]);},
  });
  assert.deepEqual(await post({operation:"listTeams",workspaceId:"lab-1"}),[]);
  current={...target,enabled:false};
  await assert.rejects(post({operation:"listTeams",workspaceId:"lab-1"}),noAccess);
  current={...target,deviceId:"dev_other_agent_12345678"};
  await assert.rejects(post({operation:"listTeams",workspaceId:"lab-1"}),noAccess);
  current={...target,allowedSemanticCapabilities:[]};
  await assert.rejects(post({operation:"listTeams",workspaceId:"lab-1"}),noAccess);
  assert.equal(dispatched,1);
});
