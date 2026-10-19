import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {mkdtemp,chmod,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {executeDshAgentOperation} from "./dist/agent/deepharness.js";
import {executeAgentOperation} from "./dist/agent/operations.js";

const id="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const env={DSH_AGENT_MESH_ENABLED:"1",DSH_AGENT_MESH_WORKSPACE_ID:"lab-1",DSH_AGENT_MESH_LEAD_SESSION_ID:"lead-1"};
const task=(operation,args={})=>({op:"deepharness.semantic",args:{operation,workspaceId:"lab-1",...args}});
const denied=value=>{assert.equal(value.code,1);assert.equal(value.stdout,"");assert.equal(value.stderr,"deepharness_agent_mesh_unavailable");};
async function serve(handler){
  const dir=await mkdtemp(join(tmpdir(),"dsh-agent-socket-"));
  await chmod(dir,0o700);
  const socket=join(dir,"bridge.sock");
  const server=http.createServer(handler);
  try{
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});
    await chmod(socket,0o600);
  }catch(e){await rm(dir,{recursive:true,force:true});throw e;}
  return {socket,close:async()=>{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }};
}
test("real agent dispatcher denies semantic operation by default",async()=>{
  const prior=process.env.DSH_AGENT_MESH_ENABLED;
  delete process.env.DSH_AGENT_MESH_ENABLED;
  try{denied(await executeAgentOperation(task("listTeams")));}finally{
    if(prior===undefined)delete process.env.DSH_AGENT_MESH_ENABLED;
    else process.env.DSH_AGENT_MESH_ENABLED=prior;
  }
});
test("enabled but absent private relay still fails closed",async()=>{
  denied(await executeDshAgentOperation(task("getTeamStatus",{leadSessionId:"lead-1"}),{},{
    env,socketPath:"/run/wandora/deepharness-semantic/does-not-exist.sock",
  }));
});
test("local Unix relay carries only fixed route and filters other Lead teams",async t=>{
  const seen=[];
  const relay=await serve(async(req,res)=>{
    assert.equal(req.method,"POST");
    assert.equal(req.url,"/wandora/dsh-bridge/v1");
    assert.equal(req.headers["content-type"],"application/json");
    const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    assert.equal(Object.keys(body).some(k=>["hostname","url","token","actor","target"].includes(k)),false);
    const result=body.operation==="listTeams"?[
      {leadSessionId:"other-lead",members:[],tasks:[]},
      {leadSessionId:"lead-1",members:[],tasks:[]},
    ]:body.operation==="sendLeadInstruction"?
      {accepted:true,requestId:body.requestId}:{messages:[],hasMore:false};
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({result}));
  });
  t.after(relay.close);
  const deps={env,socketPath:relay.socket};
  const teams=await executeDshAgentOperation(task("listTeams"),{},deps);
  assert.equal(teams.code,0);
  assert.deepEqual(JSON.parse(teams.stdout).map(v=>v.leadSessionId),["lead-1"]);
  const msg=await executeDshAgentOperation(task("sendLeadInstruction",{
    leadSessionId:"lead-1",requestId:id,text:"synthetic test only",
  }),{},deps);
  assert.equal(msg.code,0);
  assert.deepEqual(JSON.parse(msg.stdout),{accepted:true,requestId:id});
  assert.equal(seen.length,2);
  assert.deepEqual(seen[1],{operation:"sendLeadInstruction",workspaceId:"lab-1",
    leadSessionId:"lead-1",requestId:id,text:"synthetic test only"});
});
test("independent host scope and request validation denies arbitrary Agent Mesh commands",async()=>{
  const bad=[
    task("listTeams",{url:"http://127.0.0.1:9999"}),
    task("shell"),task("docker.exec"),
    task("listTeams",{workspaceId:"another"}),
    task("readLeadChat",{leadSessionId:"another",maxMessages:1}),
    task("readLeadChat",{leadSessionId:"lead-1",maxMessages:100}),
    task("sendLeadInstruction",{leadSessionId:"lead-1",requestId:id,text:" "}),
    task("sendLeadInstruction",{leadSessionId:"lead-1",requestId:id,text:"x".repeat(4097)}),
    {...task("listTeams"),secret:"forged"},
  ];
  for(const request of bad){
    denied(await executeDshAgentOperation(request,{},{
      env,socketPath:"/run/wandora/deepharness-semantic/not-present.sock",
    }));
  }
});
test("relay response metadata, bounds and write acknowledgement are checked independently",async t=>{
  let answer={result:{accepted:true,requestId:"another"}};
  let status=200,ctype="application/json";
  const relay=await serve(async(_req,res)=>{
    for await(const _chunk of _req) { /* consume bounded client payload */ }
    res.writeHead(status,{"content-type":ctype});
    res.end(JSON.stringify(answer));
  });
  t.after(relay.close);
  const deps={env,socketPath:relay.socket};
  const operation=task("sendLeadInstruction",{leadSessionId:"lead-1",requestId:id,text:"synthetic"});
  denied(await executeDshAgentOperation(operation,{},deps));
  answer={result:{accepted:true,requestId:id,extra:"leak"}};
  denied(await executeDshAgentOperation(operation,{},deps));
  status=403;answer={result:{accepted:true,requestId:id}};
  denied(await executeDshAgentOperation(operation,{},deps));
  status=200;ctype="text/plain";
  denied(await executeDshAgentOperation(operation,{},deps));
  ctype="application/json";answer={result:"x".repeat(262145)};
  denied(await executeDshAgentOperation(task("listTeams"),{},deps));
});

test("full synthetic receiver-to-local-relay contract crosses actual Unix socket, not Docker",async t=>{
  const {createDshAgentMeshUnixRelayHandler}=await import("./integrations/deepharness/agent-mesh-unix-relay.mjs");
  const forwarded=[];
  const handler=createDshAgentMeshUnixRelayHandler({
    workspaceId:"lab-1",leadSessionId:"lead-1",
    postJson:async operation=>{
      forwarded.push(operation);
      if(operation.operation==="sendLeadInstruction")
        return {accepted:true,requestId:operation.requestId};
      if(operation.operation==="listTeams")
        return [{leadSessionId:"lead-1",members:[],tasks:[]}];
      throw Error("unapproved fixture operation");
    },
  });
  const relay=await serve(handler);
  t.after(relay.close);
  const deps={env,socketPath:relay.socket};
  const list=await executeDshAgentOperation(task("listTeams"),{},deps);
  assert.equal(list.code,0);
  assert.equal(JSON.parse(list.stdout)[0].leadSessionId,"lead-1");
  const ack=await executeDshAgentOperation(task("sendLeadInstruction",{
    leadSessionId:"lead-1",requestId:id,text:"synthetic no model",
  }),{},deps);
  assert.equal(ack.code,0);
  assert.deepEqual(JSON.parse(ack.stdout),{accepted:true,requestId:id});
  assert.deepEqual(forwarded.map(x=>x.operation),["listTeams","sendLeadInstruction"]);
  assert.equal(forwarded.every(x=>x.workspaceId==="lab-1"&&
    (!Object.hasOwn(x,"leadSessionId")||x.leadSessionId==="lead-1")),true);
  assert.equal(forwarded.every(x=>!Object.hasOwn(x,"token")&&!Object.hasOwn(x,"hostname")),true);
});
