import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createDshAgentMeshUnixRelayHandler,createDshAgentMeshUnixRelayOverMtls} from "./agent-mesh-unix-relay.mjs";
import {DSH_BRIDGE_PATH} from "./private-bridge-client.mjs";

const key="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const scope={workspaceId:"lab-1",leadSessionId:"lead-1"};
async function socketServer(t,handler){
  const dir=await mkdtemp(join(tmpdir(),"dsh-relay-test-"));
  const path=join(dir,"relay.sock");
  const server=http.createServer(handler);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(path,resolve);});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return path;
}
async function send(socket,payload,{method="POST",path=DSH_BRIDGE_PATH,type="application/json",length}={}){
  const body=typeof payload==="string"?payload:JSON.stringify(payload);
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:socket,path,method,
      headers:{"content-type":type,"content-length":length??Buffer.byteLength(body)}},res=>{
        const chunks=[];res.on("data",chunk=>chunks.push(chunk));
        res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,
          body:Buffer.concat(chunks).toString("utf8")}));
      });
    req.once("error",reject);req.end(body);
  });
}
test("relay constructor does not install a listener or accept missing mTLS settings",()=>{
  assert.throws(()=>createDshAgentMeshUnixRelayHandler({...scope}),/configuration/);
  assert.throws(()=>createDshAgentMeshUnixRelayHandler({postJson:async()=>[],workspaceId:"../bad",leadSessionId:"lead-1"}),/configuration/);
  assert.throws(()=>createDshAgentMeshUnixRelayOverMtls({...scope,tls:{}}),/unavailable/);
});
test("Unix relay forwards exact scoped reads and an instruction through the fixed client",async t=>{
  const calls=[];
  const handler=createDshAgentMeshUnixRelayHandler({...scope,postJson:async payload=>{
    calls.push(payload);
    switch(payload.operation){
      case "listTeams": return [
        {leadSessionId:"other-lead",members:[],tasks:[]},
        {leadSessionId:"lead-1",members:[],tasks:[]},
      ];
      case "getTeamStatus":return {leadSessionId:"lead-1",members:[],tasks:[]};
      case "listTasks":return [];
      case "readLeadChat":return {messages:[{role:"user",text:"synthetic"}],hasMore:false};
      case "sendLeadInstruction":return {accepted:true,requestId:payload.requestId};
      default:throw Error("unexpected_operation");
    }
  }});
  const socket=await socketServer(t,handler);
  const requests=[
    {operation:"listTeams",workspaceId:"lab-1"},
    {operation:"getTeamStatus",...scope},
    {operation:"listTasks",...scope},
    {operation:"readLeadChat",...scope,maxMessages:2},
    {operation:"sendLeadInstruction",...scope,requestId:key,text:"synthetic instruction"},
  ];
  for (const payload of requests) {
    const response=await send(socket,payload);
    assert.equal(response.status,200,`${payload.operation}: ${response.body}`);
    assert.equal(response.headers["cache-control"],"no-store");
    const value=JSON.parse(response.body).result;
    if(payload.operation==="listTeams")assert.deepEqual(value.map(x=>x.leadSessionId),["lead-1"]);
    if(payload.operation==="sendLeadInstruction")assert.deepEqual(value,{accepted:true,requestId:key});
  }
  assert.deepEqual(calls.map(x=>x.operation),requests.map(x=>x.operation));
  assert.deepEqual(calls[4],requests[4]);
  assert.equal(calls.every(x=>!Object.hasOwn(x,"actor")&&!Object.hasOwn(x,"token")),true);
});
test("relay refuses all unauthorized local requests before any DSH dispatch",async t=>{
  const dispatched=[];
  const handler=createDshAgentMeshUnixRelayHandler({...scope,postJson:async payload=>{
    dispatched.push(payload);return [];
  }});
  const socket=await socketServer(t,handler);
  const valid={operation:"listTeams",workspaceId:"lab-1"};
  const bad=[
    [{...valid,url:"https://example.com"},{}],
    [{...valid,token:"forged"},{}],
    [{...valid,workspaceId:"other-lab"},{}],
    [{operation:"getTeamStatus",workspaceId:"lab-1",leadSessionId:"other-lead"},{}],
    [{operation:"readLeadChat",...scope,maxMessages:100},{}],
    [{operation:"sendLeadInstruction",...scope,requestId:key,text:" "},{}],
    [{operation:"sendLeadInstruction",...scope,requestId:"bogus",text:"go"},{}],
    [{operation:"docker.exec",...scope},{}],
    [valid,{method:"GET"}],
    [valid,{path:"/any-other-route"}],
    [valid,{type:"text/plain"}],
    ["{" ,{}],
    [{...valid,data:"x".repeat(18000)},{}],
  ];
  for (const [payload,opts] of bad) {
    const response=await send(socket,payload,opts);
    assert.equal(response.status,403,JSON.stringify(payload).slice(0,100));
    assert.equal(response.body.includes("synthetic"),false);
  }
  assert.equal(dispatched.length,0);
});
test("upstream TLS failure, wrong Lead and oversize responses do not escape relay",async t=>{
  let answer={leadSessionId:"another",members:[],tasks:[]};
  let fail=false;
  const handler=createDshAgentMeshUnixRelayHandler({...scope,postJson:async()=>{
    if(fail)throw Error("upstream certificate/key private details");
    return answer;
  }});
  const socket=await socketServer(t,handler);
  const payload={operation:"getTeamStatus",...scope};
  assert.equal((await send(socket,payload)).status,403);
  answer={leadSessionId:"lead-1",members:[],tasks:[],extra:"x".repeat(262145)};
  assert.equal((await send(socket,payload)).status,403);
  fail=true;
  const denied=await send(socket,payload);
  assert.equal(denied.status,403);
  assert.equal(denied.body.includes("certificate/key"),false);
});
