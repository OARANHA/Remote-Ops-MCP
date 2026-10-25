import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {executeDshPlatformAgentOperation} from "./platform-admin-agent-receiver.mjs";

const req={op:"deepharness.platform",args:{operation:"listWorkspaces"}};
const group=2201,owner=2101;
const env={DSH_PLATFORM_AGENT_ENABLED:"1",DSH_PLATFORM_RELAY_UID:String(owner),
 DSH_PLATFORM_SOCKET_GID:String(group)};
const stat=async path=>path.endsWith("bridge.sock")?
 {isSocket:()=>true,isDirectory:()=>false,uid:owner,gid:group,mode:0o660}:
 {isDirectory:()=>true,isSocket:()=>false,uid:owner,gid:group,mode:0o2710};
function transport(packet,status=200){
 return (_options,callback)=>{
  const outgoing=new EventEmitter();
  outgoing.setTimeout=()=>{};
  outgoing.end=()=>{
   const incoming=new EventEmitter();
   incoming.statusCode=status;
   incoming.headers={"content-type":"application/json"};
   callback(incoming);
   process.nextTick(()=>{
    incoming.emit("data",Buffer.from(JSON.stringify(packet)));
    incoming.emit("end");
   });
  };
  return outgoing;
 };
}
const deps={env,lstat:stat,agentUid:1001,agentGroups:[1001,group],
 request:transport({result:[{id:"workspace-a"}]})};
test("accepts bounded listWorkspaces JSON array on private receiver",async()=>{
 const result=await executeDshPlatformAgentOperation(req,{},deps);
 assert.equal(result.code,0);
 assert.deepEqual(JSON.parse(result.stdout),[{id:"workspace-a"}]);
 assert.equal(result.stderr,"");
});
test("rejects disabled host receiver before contacting socket",async()=>{
 const result=await executeDshPlatformAgentOperation(req,{},{
  ...deps,env:{...env,DSH_PLATFORM_AGENT_ENABLED:"0"},
  request:()=>{throw Error("should not call");},
 });
 assert.equal(result.code,1);
 assert.equal(result.stdout,"");
 assert.equal(result.stderr,"deepharness_platform_receiver_unavailable");
});
test("rejects untrusted socket permissions and unauthorized group",async()=>{
 for(const invalid of [
  {...deps,agentGroups:[1001]},
  {...deps,lstat:async path=>({...await stat(path),mode:0o777})},
  {...deps,agentUid:0},
 ]){
  const result=await executeDshPlatformAgentOperation(req,{},invalid);
  assert.equal(result.code,1);
 }
});
test("rejects malformed private JSON packet and non-200 status",async()=>{
 for(const request of [
  transport({results:[]}),transport({result:null}),transport({result:[]},403),
 ]){
  const result=await executeDshPlatformAgentOperation(req,{}, {...deps,request});
  assert.equal(result.code,1);
 }
});
test("rejects unauthorized operation envelope",async()=>{
 const result=await executeDshPlatformAgentOperation(
  {op:"deepharness.platform",args:{operation:"shell",command:"id"}},{},deps);
 assert.equal(result.code,1);
});
