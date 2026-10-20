import test from "node:test";
import assert from "node:assert/strict";
import {evaluateDshRelayHostPreflight} from "./relay-host-preflight.mjs";

const NETWORK="deepharness_mcp-private";
function baseline(){
  return {
    hostname:"28server",agentActive:"active",agentUser:"ops-mcp",
    agentGroup:"ops-mcp",agentUid:"999",agentGid:"987",relayUid:"12022",
    network:{Name:NETWORK,Internal:true},
    web:{Name:"/deepharness-web-1",Config:{User:"1000:1000"},
      NetworkSettings:{Networks:{[NETWORK]:{Aliases:["web","deepharness-mcp-backend"]}}}},
    proxy:{Name:"/deepharness-mcp-proxy-1",Config:{User:"1000:1000"},
      NetworkSettings:{Networks:{[NETWORK]:{Aliases:["mcp-proxy"]}}}},
    directory:{present:false},socket:{present:false},
  };
}
test("review-only preflight accepts observed private network with a distinct candidate UID",()=>{
  const result=evaluateDshRelayHostPreflight(baseline());
  assert.equal(result.mode,"read_only_review");
  assert.equal(result.status,"PREPARE_ONLY");
  assert.equal(result.activation_authorized,false);
  assert.equal(result.secrets_verified,false);
  assert.equal(result.mtls_listener_verified,false);
  assert.deepEqual(result.failures,[]);
});
test("missing candidate UID, same agent UID, same web UID and wrong host fail closed",()=>{
  for(const change of [
    {relayUid:undefined},{relayUid:"999"},{relayUid:"1000"},
    {relayUid:"0"},{relayUid:"-5"},{relayUid:"../../etc"},
    {hostname:"vmi3617290"},{agentActive:"inactive"},
    {agentGroup:"root"},{agentGid:"0"},
  ]){
    const result=evaluateDshRelayHostPreflight({...baseline(),...change});
    assert.equal(result.status,"NO_GO",JSON.stringify(change));
    assert.ok(result.failures.length>0,JSON.stringify(change));
  }
});
test("missing network, public network, unexpected proxy or missing backend alias fail",()=>{
  for(const patch of [
    {network:{Name:NETWORK,Internal:false}},
    {network:{Name:"bridge",Internal:true}},
    {web:{...baseline().web,Config:{User:"0:0"}}},
    {web:{...baseline().web,NetworkSettings:{Networks:{[NETWORK]:{Aliases:["web"]}}}}},
    {proxy:{...baseline().proxy,NetworkSettings:{Networks:{}}}},
    {proxy:{...baseline().proxy,Name:"/wrong"}},
  ])assert.equal(evaluateDshRelayHostPreflight({...baseline(),...patch}).status,"NO_GO");
});
test("unexpected or insecure existing directory or socket is rejected",()=>{
  const okay=baseline();
  assert.equal(evaluateDshRelayHostPreflight({...okay,directory:{
    present:true,uid:12022,gid:987,mode:0o2710,directory:true,socket:false,symlink:false,
  }}).status,"PREPARE_ONLY");
  for(const change of [
    {socket:{present:true}},
    {socket:{present:null}},
    {directory:{present:null}},
    {directory:{present:true,uid:999,gid:987,mode:0o2710,directory:true,symlink:false}},
    {directory:{present:true,uid:12022,gid:987,mode:0o2777,directory:true,symlink:false}},
    {directory:{present:true,uid:12022,gid:987,mode:0o2710,directory:true,symlink:true}},
  ])assert.equal(evaluateDshRelayHostPreflight({...okay,...change}).status,"NO_GO");
});
