import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {composeDeepharnessReadWriteOverAgentMesh} from "./composition.mjs";
import {createPersistentDshGrantStore} from "./persistent-grant-store.mjs";

const target={
  id:"deepharness-semantic-lab",transport:"agent",environment:"development",
  capabilityProfile:"semantic-operator",enabled:true,
  deviceId:"dev_lab_agent_12345678",allowedSemanticCapabilities:["deepharness.semantic"],
};
const caller={actor:"oauth:client-1:session-0123",clientId:"client-1",
  sessionId:"session-0123456789abcdef"};
const scope={workspaceId:"lab-1",leadSessionId:"lead-1"};
function successful(result){return {code:0,stdout:JSON.stringify(result),stderr:"",
  durationMs:2,truncated:false,timedOut:false};}
test("actual durable OAuth grant policy routes only scoped work over trusted semantic Agent Mesh",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"dsh-agent-policy-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,"grants.json");
  const grantStore=createPersistentDshGrantStore({file});
  await grantStore.putGrant({...caller,...scope,
    actions:["team.read","chat.read","lead.instruct"]});
  const delivered=[];
  const dispatchAgentOperation=async (deviceId,envelope,limits)=>{
    assert.equal(deviceId,target.deviceId);
    assert.equal(envelope.op,"deepharness.semantic");
    assert.ok(limits.timeoutMs<=10000);
    const req=envelope.args;
    delivered.push(req);
    if(req.operation==="getTeamStatus")return successful({
      leadSessionId:scope.leadSessionId,
      members:[{id:scope.leadSessionId,role:"lead",name:"Lead",phase:"active"}],
      tasks:[{id:"task-1",revision:1,subject:"Synthetic",description:"",status:"pending",
        blockedBy:[],writeScopes:[],writeScopeWarnings:[],ready:true}],
    });
    if(req.operation==="readLeadChat")
      return successful({messages:[{role:"assistant",text:"synthetic response"}],hasMore:false});
    if(req.operation==="sendLeadInstruction")
      return successful({accepted:true,requestId:req.requestId});
    throw Error("unlisted_operation");
  };
  const policy=composeDeepharnessReadWriteOverAgentMesh({
    grantStore,target,lookupCurrentTarget:()=>target,dispatchAgentOperation,
  });
  const team=await policy.readTeam(caller,scope);
  assert.equal(team.lead_session_id,scope.leadSessionId);
  assert.deepEqual(team.tasks.map(x=>x.subject),["Synthetic"]);
  const chat=await policy.readChat(caller,{...scope,limit:2});
  assert.deepEqual(chat.messages,[{role:"assistant",text:"synthetic response"}]);
  const key=randomUUID();
  const input={...scope,instruction:"synthetic instruction",idempotencyKey:key};
  const receipt=await policy.sendLeadInstruction(caller,input);
  assert.equal(receipt.accepted,true);
  const repeated=await policy.sendLeadInstruction(caller,input);
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.receipt_id,receipt.receipt_id);
  assert.equal(delivered.filter(x=>x.operation==="sendLeadInstruction").length,1);
  assert.equal(delivered.every(x=>!Object.hasOwn(x,"clientId")&&
    !Object.hasOwn(x,"sessionId")&&!Object.hasOwn(x,"actor")&&
    !Object.hasOwn(x,"url")&&!Object.hasOwn(x,"target")),true);
  const saved=await readFile(file,"utf8");
  assert.equal(saved.includes("synthetic instruction"),false);
  assert.equal(saved.includes("session-0123456789abcdef"),true); // persisted grant identity, not access token
  const beforeRevocation=delivered.length;
  await grantStore.revokeGrant({...caller,...scope});
  await assert.rejects(policy.readTeam(caller,scope),/capability_denied/);
  await assert.rejects(policy.sendLeadInstruction(caller,{
    ...scope,instruction:"forbidden",idempotencyKey:randomUUID(),
  }),/capability_denied/);
  assert.equal(delivered.length,beforeRevocation);
});
test("wrong target, another OAuth session and missing exact grant deny without Agent Mesh dispatch",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"dsh-agent-policy-deny-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createPersistentDshGrantStore({file:join(dir,"grants.json")});
  await store.putGrant({...caller,...scope,actions:["team.read"]});
  let forwarded=0;
  const dispatchAgentOperation=async()=>{forwarded++;return successful({});};
  assert.throws(()=>composeDeepharnessReadWriteOverAgentMesh({
    grantStore:store,target:{...target,id:"deepharness-read"},
    lookupCurrentTarget:()=>target,dispatchAgentOperation,
  }),/unavailable/);
  const policy=composeDeepharnessReadWriteOverAgentMesh({
    grantStore:store,target,lookupCurrentTarget:()=>target,dispatchAgentOperation,
  });
  await assert.rejects(policy.readTeam({...caller,sessionId:"forged-session"},scope),/capability_denied/);
  await assert.rejects(policy.readTeam(caller,{...scope,leadSessionId:"other-lead"}),/capability_denied/);
  await assert.rejects(policy.sendLeadInstruction(caller,{
    ...scope,instruction:"forbidden",idempotencyKey:randomUUID(),
  }),/capability_denied/);
  assert.equal(forwarded,0);
});
