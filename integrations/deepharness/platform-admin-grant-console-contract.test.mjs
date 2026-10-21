import test from "node:test";
import assert from "node:assert/strict";
import {selectCurrentDshPlatformGrantSubject} from "./platform-admin-grant-console-contract.mjs";
const sid="sess-current-oauth-abcdefghijklmnop";
const clientId="client-1";
const principal=()=>({
  sessions:[{session_id:sid,client_id:clientId,revoked_at:null,refresh_expires_at:1000000}],
  clients:[{client_id:clientId,revoked_at:null}],
  sessionId:sid,now:100000,
});
const denied=/deepharness_platform_grant_admin_denied/;
test("read and manage select only live OAuth session and predefined managed scope",()=>{
  const a=selectCurrentDshPlatformGrantSubject({...principal(),operation:"read",
    confirmation:"GRANT READ DSH PLATFORM"});
  assert.equal(a.actor,"oauth:"+clientId+":"+sid.slice(0,12));
  assert.equal(a.rootScope,"managed");
  assert.deepEqual(a.actions,["workspace.list","session.list"]);
  assert.ok(Object.isFrozen(a.actions));
  const b=selectCurrentDshPlatformGrantSubject({...principal(),operation:"manage",
    confirmation:"GRANT MANAGE DSH PLATFORM"});
  assert.equal(b.actions.length,8);
  assert.equal(b.sessionId,sid);
  assert.ok(!Object.hasOwn(b,"password")&&!Object.hasOwn(b,"path"));
});
test("revoke is valid on retired session but never grants actions",()=>{
  const p=principal();
  p.sessions[0].revoked_at=100;
  p.clients[0].revoked_at=100;
  const a=selectCurrentDshPlatformGrantSubject({...p,operation:"revoke",
    confirmation:"REVOKE DSH PLATFORM"});
  assert.deepEqual(a.actions,[]);
  assert.equal(a.operation,"revoke");
});
test("reject revoked, expired, missing and ambiguous OAuth identities",()=>{
  const p=principal();
  const run=override=>selectCurrentDshPlatformGrantSubject({...p,
    operation:"manage",confirmation:"GRANT MANAGE DSH PLATFORM",...override});
  for(const x of [
    {sessionId:"other"}, {sessions:[]}, {clients:[]},
    {sessions:[...p.sessions,...p.sessions]},
    {clients:[...p.clients,...p.clients]},
    {sessions:[{...p.sessions[0],revoked_at:1}]},
    {clients:[{...p.clients[0],revoked_at:1}]},
    {sessions:[{...p.sessions[0],refresh_expires_at:99999}]},
    {sessions:[{...p.sessions[0],client_id:"forged"}]},
    {now:NaN}, {now:Infinity},
    {operation:"root"}, {confirmation:"GRANT READ DSH PLATFORM"},
    {confirmation:""}, {confirmation:"grant manage dsh platform"},
  ])assert.throws(()=>run(x),denied);
});
test("denies callers supplying a personal identity without a trusted OAuth record",()=>{
  const p=principal();
  assert.throws(()=>selectCurrentDshPlatformGrantSubject({
    ...p,sessionId:"oauth:root:forged",operation:"manage",
    confirmation:"GRANT MANAGE DSH PLATFORM",
  }),denied);
});
