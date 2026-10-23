import test from "node:test";
import assert from "node:assert/strict";
import {createDshCleanupSkillReader} from "./platform-cleanup-skill-catalog.mjs";
const params={workspaceId:"workspace-1",sessionId:"session-1"};
test("official skills.list session read does not authorize cleanup",async()=>{
 const calls=[];
 const reader=createDshCleanupSkillReader({
  authorizeRead:async s=>calls.push(s),
  listSkills:async x=>{assert.deepEqual(x,{sessionId:"session-1"});return {skills:[
   {name:"testing",description:"Test skill",modelInvocable:true,path:"/data/project/.agents/skills/testing/SKILL.md"}
  ]};}
 });
 const r=await reader.list(params);
 assert.equal(r.skills.length,1);
 assert.equal(r.cleanupAuthorized,false);
 assert.equal(r.projectRootsComplete,false);
 assert.equal(r.globalRootsComplete,false);
 assert.equal(calls.length,2);
 assert.equal(calls[0].operation,"skills.list");
});
test("no valid official registry or authorizer denies",()=>{
 assert.throws(()=>createDshCleanupSkillReader({}),/unavailable/);
});
test("malformed path and duplicate skills fail closed",async()=>{
 for(const skills of [[{name:"x",description:"ok",modelInvocable:false,path:"/root/../escape"}],
 [{name:"x",description:"ok",modelInvocable:false},{name:"x",description:"ok",modelInvocable:false}]]){
 const reader=createDshCleanupSkillReader({authorizeRead:async()=>{},listSkills:async()=>({skills})});
 await assert.rejects(reader.list(params),/unavailable/);
 }
});
test("revocation on readback rejects",async()=>{
 let n=0;
 const reader=createDshCleanupSkillReader({authorizeRead:async()=>{if(++n===2)throw Error("revoked");},
 listSkills:async()=>({skills:[]})});
 await assert.rejects(reader.list(params),/revoked/);
});
test("unknown or missing identifiers deny before reads",async()=>{
 let calls=0;
 const reader=createDshCleanupSkillReader({authorizeRead:async()=>calls++,listSkills:async()=>({skills:[]})});
 await assert.rejects(reader.list({workspaceId:"../",sessionId:"x"}),/unavailable/);
 assert.equal(calls,0);
});
