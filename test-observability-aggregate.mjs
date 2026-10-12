import test from "node:test";import assert from "node:assert/strict";
import {summarizeTargetObservations} from "./dist/observability/aggregate.js";
const m=(name,status,value=status==="unknown"?null:1)=>({name,status,value,unit:name==="disk.usage"?"percent":"bytes",reason:status==="unknown"?"missing":"measured"});
const base={targetId:"alpha",capturedAt:"2026-10-12T03:00:00Z",source:"agent",completeness:"complete",metrics:[m("disk.usage","crit"),m("memory.total","unknown")]};
test("critical does not hide unknown coverage",()=>{const x=summarizeTargetObservations([base])[0];assert.equal(x.level,"crit");assert.equal(x.completeness,"partial");assert.equal(x.counts.unknown,1);});
test("empty and duplicate observations",()=>{assert.deepEqual(summarizeTargetObservations([]),[]);assert.throws(()=>summarizeTargetObservations([base,base]),/DUPLICATE/);});
test("sorting and target isolation",()=>{const xs=summarizeTargetObservations([{...base,targetId:"zeta"},base]);assert.deepEqual(xs.map(x=>x.targetId),["alpha","zeta"]);});
