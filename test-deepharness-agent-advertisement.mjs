import test from "node:test";
import assert from "node:assert/strict";
import {canAdvertiseDshSemantic} from "./dist/agent/deepharness-advertisement.js";
const socket="/run/wandora/deepharness-semantic/bridge.sock";
const folder="/run/wandora/deepharness-semantic";
const env={
  DSH_AGENT_MESH_ENABLED:"1",DSH_AGENT_MESH_WORKSPACE_ID:"lab-1",
  DSH_AGENT_MESH_LEAD_SESSION_ID:"lead-1",
  DSH_AGENT_MESH_RELAY_UID:"13002",DSH_AGENT_MESH_SOCKET_GID:"13001",
};
const identity=()=>({uid:13001,gid:13001,groups:[13001]});
function stats(dir=false){
  return {uid:13002,gid:13001,mode:dir?0o2710:0o660,
    isDirectory:()=>dir,isSocket:()=>!dir,isSymbolicLink:()=>false};
}
const stat=path=>path===folder?stats(true):path===socket?stats(false):(()=>{throw Error("unexpected path");})();
test("advertisement requires exact host opt-in and matching private socket",()=>{
  assert.equal(canAdvertiseDshSemantic(),false);
  assert.equal(canAdvertiseDshSemantic({env,identity,stat}),true);
  assert.equal(canAdvertiseDshSemantic({env:{...env,DSH_AGENT_MESH_ENABLED:"0"},identity,stat}),false);
  assert.equal(canAdvertiseDshSemantic({env:{...env,DSH_AGENT_MESH_LEAD_SESSION_ID:"../invalid"},identity,stat}),false);
  assert.equal(canAdvertiseDshSemantic({env:{...env,DSH_AGENT_MESH_RELAY_UID:"0"},identity,stat}),false);
  assert.equal(canAdvertiseDshSemantic({env:{...env,DSH_AGENT_MESH_SOCKET_GID:"oops"},identity,stat}),false);
});
test("advertisement refuses same-UID relay, untrusted group, root and path mismatch",()=>{
  for(const badIdentity of [
    {uid:13002,gid:13001,groups:[13001]},
    {uid:0,gid:13001,groups:[13001]},
    {uid:13001,gid:13999,groups:[13999]},
  ])assert.equal(canAdvertiseDshSemantic({env,identity:()=>badIdentity,stat}),false);
  for(const failing of [
    path=>{throw Error("missing socket");},
    path=>path===folder?{...stats(true),mode:0o777}:stats(false),
    path=>path===folder?{...stats(true),uid:0}:stats(false),
    path=>path===folder?stats(true):{...stats(false),mode:0o666},
    path=>path===folder?stats(true):{...stats(false),isSymbolicLink:()=>true},
    path=>path===folder?stats(true):{...stats(false),gid:13999},
  ])assert.equal(canAdvertiseDshSemantic({env,identity,stat:failing}),false);
});
