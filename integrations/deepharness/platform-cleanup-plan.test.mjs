import test from "node:test";
import assert from "node:assert/strict";
import {planDshCleanup} from "./platform-cleanup-plan.mjs";

const sample=()=>({
  complete:true,
  workspaces:[{id:"lab",sessionCount:0,sessionsComplete:true,activity:"idle",skillRootsComplete:true}],
  skills:{complete:true,rootsComplete:true,entries:[]},
});
test("pure preview allows no deletion, even for empty workspace",()=>{
  const result=planDshCleanup(sample());
  assert.equal(result.workspaces[0].registryDeregistrationCandidate,true);
  assert.equal(result.workspaces[0].filesystemDeletionAllowed,false);
  assert.equal(result.executionAuthorized,false);
  assert.match(result.inventoryFingerprint,/^[0-9a-f]{64}$/);
});
test("project skills block candidate",()=>{
  const i=sample();i.skills.entries.push({path:"/managed/lab/.agents/skills/critical/SKILL.md",origin:"project",workspaceId:"lab"});
  assert.deepEqual(planDshCleanup(i).workspaces[0].blockers,["project_skills_present"]);
});
test("nonempty session registry blocks candidate",()=>{
  const i=sample();i.workspaces[0].sessionCount=7;
  assert.deepEqual(planDshCleanup(i).workspaces[0].blockers,["sessions_present"]);
});
test("unknown activity and incomplete roots block candidate",()=>{
  const i=sample();i.workspaces[0].activity="unknown";i.workspaces[0].skillRootsComplete=false;
  assert.deepEqual(planDshCleanup(i).workspaces[0].blockers,["activity_not_idle","skills_not_fully_inventoried"]);
});
test("unknown global skill roots deny",()=>{
  const i=sample();i.skills.rootsComplete=false;
  assert.throws(()=>planDshCleanup(i),/denied/);
});
test("inventory gaps or invalid references deny",()=>{
  const i=sample();i.workspaces[0].sessionsComplete=false;
  assert.throws(()=>planDshCleanup(i),/denied/);
  const j=sample();j.skills.entries.push({path:"/tmp/skill.md",origin:"project",workspaceId:"other"});
  assert.throws(()=>planDshCleanup(j),/denied/);
});
test("fingerprint independent of workspace input order",()=>{
  const a=sample();a.workspaces.push({id:"elus",sessionCount:1,sessionsComplete:true,activity:"idle",skillRootsComplete:true});
  const b=structuredClone(a);b.workspaces.reverse();
  assert.equal(planDshCleanup(a).inventoryFingerprint,planDshCleanup(b).inventoryFingerprint);
});
