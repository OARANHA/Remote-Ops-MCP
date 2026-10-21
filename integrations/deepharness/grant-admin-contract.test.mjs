import test from "node:test";
import assert from "node:assert/strict";
import {selectCurrentDshGrantSubject as select} from "./grant-admin-contract.mjs";

const workspaceId="fc24d43c-caf3-4059-8d82-5e9edd3c04c8";
const leadSessionId="session-83cba7de-20a3-447b-967a-36315132db1a";
const sessionId="sess-test-session-fixed-123456";
const clientId="ro-reviewed-client-12345";
const input=()=>({
  sessions:[{session_id:sessionId,client_id:clientId,refresh_expires_at:1700000123000,revoked_at:null}],
  clients:[{client_id:clientId,revoked_at:null}],
  sessionId,workspaceId,leadSessionId,
  now:1700000000000,operation:"read",confirmation:"GRANT READ TEAM_3",
});

test("only the active OAuth session defines principal, read permission stays limited",()=>{
  const subject=select(input());
  assert.equal(subject.actor,`oauth:${clientId}:${sessionId.slice(0,12)}`);
  assert.equal(subject.clientId,clientId);
  assert.deepEqual(subject.actions,["team.read","chat.read"]);
  assert.equal(subject.workspaceId,workspaceId);
  assert.equal(subject.leadSessionId,leadSessionId);
});

test("Lead instruction requires separate explicit human confirmation",()=>{
  const action={...input(),operation:"instruct"};
  assert.throws(()=>select(action));
  assert.deepEqual(select({...action,confirmation:"GRANT INSTRUCT TEAM_3"}).actions,
    ["team.read","chat.read","lead.instruct"]);
});

test("revoke emits no grant actions and requires its own confirmation",()=>{
  assert.throws(()=>select({...input(),operation:"revoke"}));
  const x=select({...input(),operation:"revoke",confirmation:"REVOKE TEAM_3"});
  assert.deepEqual(x.actions,[]);
});

for(const [name,overrides] of [
  ["unknown oauth session",{sessionId:"sess-unknown-session"}],
  ["revoked session",{sessions:[{session_id:sessionId,client_id:clientId,refresh_expires_at:1700000123000,revoked_at:123}]}],
  ["expired session",{now:1700000999000}],
  ["revoked oauth client",{clients:[{client_id:clientId,revoked_at:123}]}],
  ["untrusted client",{clients:[]}],
  ["wrong workspace",{workspaceId:"lab"}],
  ["wrong Lead",{leadSessionId:"session-other"}],
  ["unknown permission action",{operation:"admin"}],
  ["forged authorization",{confirmation:"GRANT INSTRUCT TEAM_3"}],
])test(`deny ${name}`,()=>assert.throws(()=>select({...input(),...overrides}),/deepharness_grant_admin_denied/));
