import test from "node:test";import assert from "node:assert/strict";
import {parseObservation} from "./dist/observability/contracts.js";
const base={targetId:"test-target",capturedAt:"2026-10-12T03:00:00.000Z",source:"agent",completeness:"complete",
metrics:[{name:"disk.usage",value:50,unit:"percent",status:"ok",reason:"measured"}]};
test("accepts valid bounded observation",()=>assert.equal(parseObservation(base).targetId,"test-target"));
test("strictly rejects unexpected identifying fields",()=>assert.throws(()=>parseObservation({...base,ip:"10.0.0.1"}),/INVALID_OBSERVATION/));
test("rejects duplicate metric keys",()=>assert.throws(()=>parseObservation({...base,metrics:[...base.metrics,...base.metrics]}),/INVALID_OBSERVATION/));
test("rejects NaN and invalid units",()=>{
 for(const value of [NaN,Infinity,-1,101])assert.throws(()=>parseObservation({...base,metrics:[{...base.metrics[0],value}]}));
 assert.throws(()=>parseObservation({...base,metrics:[{...base.metrics[0],unit:"bytes"}]}));
});
test("null reading must be unknown",()=>assert.throws(()=>parseObservation({...base,metrics:[{...base.metrics[0],value:null}]})));
