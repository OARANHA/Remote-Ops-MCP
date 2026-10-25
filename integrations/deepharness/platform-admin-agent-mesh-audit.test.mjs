import test from "node:test";
import assert from "node:assert/strict";
import {createDshPlatformAgentMeshDispatcher} from "./platform-admin-agent-mesh-client.mjs";
const target={id:"deepharness-platform-private",transport:"agent",environment:"development",
 capabilityProfile:"semantic-operator",enabled:true,deviceId:"dev_12345678",
 allowedSemanticCapabilities:["deepharness.platform"]};
const envelope={op:"deepharness.platform",args:{operation:"listWorkspaces"}};
function setup(lookupCurrentTarget,dispatchAgentOperation){
 const stages=[];
 const dispatcher=createDshPlatformAgentMeshDispatcher({target,lookupCurrentTarget,
  dispatchAgentOperation,auditFailure:stage=>stages.push(stage)});
 return {stages,dispatcher};
}
test("fail-closed target lookup emits only a fixed stage",async()=>{
 const {stages,dispatcher}=setup(async()=>{throw Error("sensitive exception");},async()=>{throw Error("not reached");});
 await assert.rejects(dispatcher.dispatch(envelope),/deepharness_platform_agent_mesh_unavailable/);
 assert.deepEqual(stages,["target_lookup_or_validation"]);
});
test("agent dispatch exception has distinct fixed stage",async()=>{
 const {stages,dispatcher}=setup(async()=>target,async()=>{throw Error("secret error");});
 await assert.rejects(dispatcher.dispatch(envelope),/deepharness_platform_agent_mesh_unavailable/);
 assert.deepEqual(stages,["agent_dispatch_exception"]);
});
test("invalid receiver contract has distinct fixed stage",async()=>{
 const {stages,dispatcher}=setup(async()=>target,async()=>({code:1,stderr:"internal detail",stdout:"",truncated:false,timedOut:false}));
 await assert.rejects(dispatcher.dispatch(envelope),/deepharness_platform_agent_mesh_unavailable/);
 assert.deepEqual(stages,["agent_response_contract"]);
});
test("valid response produces no failure audit",async()=>{
 const {stages,dispatcher}=setup(async()=>target,async()=>({code:0,stderr:"",stdout:'{"ok":true}',truncated:false,timedOut:false}));
 assert.deepEqual(await dispatcher.dispatch(envelope),{ok:true});
 assert.deepEqual(stages,[]);
});
