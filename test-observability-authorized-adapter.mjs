import test from "node:test";import assert from "node:assert/strict";
import {buildObservationFromAuthorizedReads} from "./dist/observability/authorized-adapter.js";
const input={targetId:"lab-safe",source:"agent",capturedAt:"2026-10-12T03:00:00Z"};
test("denied authorization executes zero read calls",async()=>{
 let reads=0;await assert.rejects(()=>buildObservationFromAuthorizedReads({...input,authorize:async()=>false,read:async()=>{reads++;return "";}}),/ACCESS_DENIED/);
 assert.equal(reads,0);
});
test("raw credential bearing transport error is not exposed",async()=>{
 const x=await buildObservationFromAuthorizedReads({...input,authorize:async()=>true,read:async()=>{throw Error("token=SUPERSECRET 10.2.3.4");}});
 assert.equal(x.completeness,"unavailable");assert.equal(JSON.stringify(x).includes("SUPERSECRET"),false);
});
test("partial read is explicit",async()=>{
 const x=await buildObservationFromAuthorizedReads({...input,authorize:async()=>true,read:async(_,op)=>op==="host.memory"?"Mem: 1000 700 200 0 100 300":Promise.reject(Error("internal"))});
 assert.equal(x.completeness,"partial");assert.equal(x.metrics.some(m=>m.status==="unknown"),true);
});
