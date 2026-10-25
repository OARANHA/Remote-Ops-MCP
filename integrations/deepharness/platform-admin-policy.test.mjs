import test from "node:test";
import assert from "node:assert/strict";
import {createDshPlatformPolicy} from "./platform-admin-policy.mjs";

const principal={actor:"oauth:client:session-0123",clientId:"client",
  sessionId:"session-0123456789abcdef"};
const workspaceId="workspace-radar",leadSessionId="lead-radar";
const operation={operation:"listTeamMemberStates",workspaceId,leadSessionId};
const validGrant=actions=>({...principal,rootScope:"managed",revokedAt:null,
  revision:"revision-1",actions});

test("team.member.read grant authorizes a workspace and Lead bound read without mutation receipt",async()=>{
  const dispatched=[],lookups=[];let writes=0;
  const policy=createDshPlatformPolicy({
    lookupCurrentGrant:async p=>{lookups.push(p);return validGrant(["team.member.read"]);},
    withAuthorizedWrite:async()=>{writes++;throw Error("must_not_write");},
    dispatchEnvelope:async envelope=>{dispatched.push(envelope);return {
      workspaceId,leadSessionId,members:[{id:"member-1",name:"pesquisador-oss",
        role:"teammate",phase:"provisioning"}],
    };},
  });
  const result=await policy.execute(principal,operation);
  assert.deepEqual(result.members,[{id:"member-1",name:"pesquisador-oss",
    role:"teammate",phase:"provisioning"}]);
  assert.equal(lookups.length,2);
  assert.equal(writes,0);
  assert.deepEqual(dispatched[0].args,operation);
  assert.equal(Object.hasOwn(dispatched[0].args,"requestId"),false);
});

test("team.member.read denial stops before dispatch when grant is absent",async()=>{
  let calls=0;
  const policy=createDshPlatformPolicy({
    lookupCurrentGrant:async()=>validGrant(["workspace.list"]),
    withAuthorizedWrite:async()=>{throw Error("must_not_write");},
    dispatchEnvelope:async()=>{calls++;return {members:[]};},
  });
  await assert.rejects(policy.execute(principal,operation),/capability_denied/);
  assert.equal(calls,0);
});

test("team.member.read denies a result if grant revision changes during the read",async()=>{
  let lookup=0;
  const changing=createDshPlatformPolicy({
    lookupCurrentGrant:async()=>({
      ...validGrant(["team.member.read"]),
      revision:++lookup===1?"revision-1":"revision-2",
    }),
    withAuthorizedWrite:async()=>{throw Error("must_not_write");},
    dispatchEnvelope:async()=>({workspaceId,leadSessionId,members:[]}),
  });
  await assert.rejects(changing.execute(principal,operation),/capability_denied/);
});
