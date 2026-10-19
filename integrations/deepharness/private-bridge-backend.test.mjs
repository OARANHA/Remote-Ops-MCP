import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteDshPrivateBridgeBackend } from "./private-bridge-backend.mjs";

const scope={workspaceId:"ws-1",leadSessionId:"lead-1",actor:"oauth:client-1:session-0123",
  clientId:"client-1",sessionId:"session-0123456789abcdef",revision:"grant-r1"};
const team={leadSessionId:"lead-1",members:[{id:"lead-1",name:"Lead",role:"lead",phase:"active"}],
  tasks:[{id:"task-1",revision:1,subject:"Check",description:"Check safely",status:"in_progress",
    blockedBy:[],writeScopes:[],ready:true,writeScopeWarnings:[]}]};
function fixture(){
  const calls=[],receipts=new Map();let current=team;
  const client={
    async getTeamStatus(input){calls.push(["team",input]);return current;},
    async readLeadChat(input){calls.push(["chat",input]);return {messages:[{role:"assistant",text:"done"}],hasMore:false};},
    async sendLeadInstruction(input){calls.push(["send",input]);return {accepted:true,requestId:input.requestId};},
  };
  const withAuthorizedLeadCommit=async(input,submit)=>{
    const key=input.idempotencyKey;
    if(receipts.has(key))return {...receipts.get(key),duplicate:true};
    const ack=await submit();
    const value={accepted:ack.accepted,authorizationCheckedAtCommit:true,grantRevision:input.revision,
      receiptId:"receipt_1",duplicate:false};
    receipts.set(key,value);return value;
  };
  const backend=createRemoteDshPrivateBridgeBackend({client,withAuthorizedLeadCommit});
  return {backend,calls,setTeam(value){current=value;}};
}

test("reads Team through the semantic client and returns a detached bounded model",async()=>{
  const f=fixture();
  assert.deepEqual(await f.backend.readAuthorizedTeam(scope),{
    workspace_id:"ws-1",lead_session_id:"lead-1",members:[{id:"lead-1",role:"lead",name:"Lead",phase:"active"}],
    tasks:[{id:"task-1",status:"in_progress",subject:"Check",description:"Check safely"}],
  });
});

test("reads bounded text chat through the exact workspace and Lead scope",async()=>{
  const f=fixture();
  assert.deepEqual(await f.backend.readAuthorizedChat({...scope,limit:10}),{
    workspace_id:"ws-1",lead_session_id:"lead-1",messages:[{role:"assistant",text:"done"}],
  });
  assert.deepEqual(f.calls.at(-1),["chat",{workspaceId:"ws-1",leadSessionId:"lead-1",maxMessages:10}]);
});

test("rechecks the Lead at commit, hashes idempotency to a stable UUID, and never forwards auth claims",async()=>{
  const f=fixture(),authorization={...scope,action:"lead.instruct",idempotencyKey:"4db3b83c-5abc-4aa3-9270-9715e3d34e38",
    payloadHash:"a".repeat(64),instruction:"Continue the lab"};
  const out=await f.backend.commitAuthorizedInstruction(authorization);
  const sends=f.calls.filter(([name])=>name==="send");
  assert.equal(sends.length,1);
  assert.deepEqual(Object.keys(sends[0][1]).sort(),["leadSessionId","requestId","text","workspaceId"]);
  assert.match(sends[0][1].requestId,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(out,{accepted:true,authorizationCheckedAtCommit:true,grantRevision:"grant-r1",
    receiptId:"receipt_1",duplicate:false});
});

test("rejects cross-Lead host projections immediately before commit",async()=>{
  const f=fixture(),authorization={...scope,action:"lead.instruct",idempotencyKey:"4db3b83c-5abc-4aa3-9270-9715e3d34e38",
    payloadHash:"a".repeat(64),instruction:"Continue"};
  f.setTeam({...team,leadSessionId:"other"});
  await assert.rejects(f.backend.commitAuthorizedInstruction(authorization),/denied/i);
  assert.equal(f.calls.some(([name])=>name==="send"),false);
});
