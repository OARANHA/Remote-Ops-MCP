import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createDshPlatformPrivateHttpHandler} from "./platform-admin-private-http-handler.mjs";
function invoke(handler,{method="POST",url="/wandora/dsh-platform/v2",headers={"content-type":"application/json"},body={op:"deepharness.platform",args:{operation:"listWorkspaces"}}}={}){
 const input=typeof body==="string"?body:JSON.stringify(body);
 const req=Readable.from([Buffer.from(input)]);
 Object.assign(req,{method,url,headers});
 const res={status:0,payload:"",headersSent:false,
  writeHead(code){this.status=code;this.headersSent=true;},
  end(data){this.payload=String(data??"");}};
 return Promise.resolve(handler(req,res)).then(()=>res);
}
test("private handler forwards only validated envelope to authenticated relay",async()=>{
 let calls=0;
 const handler=createDshPlatformPrivateHttpHandler({
  connectionForRequest:()=>({trusted:true}),
  relay:{dispatch:async(connection,envelope)=>{
   calls++;
   assert.equal(connection.trusted,true);
   assert.equal(envelope.op,"deepharness.platform");
   return [{id:"managed-a"}];
  }},
 });
 const res=await invoke(handler);
 assert.equal(res.status,200);
 assert.deepEqual(JSON.parse(res.payload),{result:[{id:"managed-a"}]});
 assert.equal(calls,1);
});
test("private handler denies invalid method/path/payload, no dispatch",async()=>{
 let calls=0;
 const handler=createDshPlatformPrivateHttpHandler({
  connectionForRequest:()=>({trusted:true}),
  relay:{dispatch:async()=>{calls++;return []}},
 });
 for(const data of [
  {method:"GET"},{url:"/admin"},{body:{op:"shell",args:{}}},
  {body:"{"},{body:"x".repeat(17000)},
  {headers:{"content-type":"text/plain"}},
 ]){
  const res=await invoke(handler,data);
  assert.notEqual(res.status,200);
 }
 assert.equal(calls,0);
});
test("private handler fails closed when transport cannot supply connection",async()=>{
 let calls=0;
 const handler=createDshPlatformPrivateHttpHandler({
  connectionForRequest:()=>null,
  relay:{dispatch:async()=>{calls++;return []}},
 });
 const res=await invoke(handler);
 assert.equal(res.status,403);assert.equal(calls,0);
});

test("private HTTP handler audits bounded upstream failures without exposing exceptions",async()=>{
 const stages=[];
 const handler=createDshPlatformPrivateHttpHandler({
  connectionForRequest:()=>({trusted:true}),
  auditStage:stage=>stages.push(stage),
  relay:{dispatch:async()=>{throw Error("sensitive-internal-diagnostic");}},
 });
 const res=await invoke(handler);
 assert.equal(res.status,403);
 assert.deepEqual(stages,["upstream"]);
 assert.equal(res.payload.includes("sensitive-internal-diagnostic"),false);
});
