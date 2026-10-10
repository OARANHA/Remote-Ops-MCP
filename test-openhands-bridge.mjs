import { test } from "node:test";
import assert from "node:assert/strict";
import { runOpenHandsCommand } from "./src/agent/openhands.ts";

const id = "11111111-1111-4111-8111-111111111111";
function response(value, status=200) { return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}); }
function deps(fetcher, extra={}) { return {fetcher,readKey:async()=>"super-secret-machine-auth-key", ...extra}; }

test("health is fixed loopback and unauthenticated",async()=>{
  let u, init;
  const r=await runOpenHandsCommand("openhands.health",{},deps(async(url,opts)=>{u=url;init=opts;return response({status:"ok",other:"private"});},{readKey:async()=>{throw Error("must not read");}}));
  assert.deepEqual(r,{healthy:true});
  assert.equal(u,"http://127.0.0.1:18080/health");
  assert.equal(init.headers["X-Session-API-Key"],undefined);
});
test("search is bounded, authenticated and returns whitelisted fields only",async()=>{
  const r=await runOpenHandsCommand("openhands.list",{limit:2},deps(async(url,opts)=>{
    assert.equal(url,"http://127.0.0.1:18080/api/conversations/search?limit=2");
    assert.equal(opts.headers["X-Session-API-Key"],"super-secret-machine-auth-key");
    assert.equal(opts.redirect,"error");
    return response({items:[{id,title:"MCP test",execution_status:"finished",agent_settings:{llm:{internal_note:"sensitive"}},created_at:"2026-10-09"}],next_page_id:"abc"});
  }));
  assert.equal(JSON.stringify(r).includes("sensitive"),false);
  assert.equal(r.items[0].id,id);
  assert.equal(r.next_page_id,"abc");
});
test("start enforces AlwaysConfirm, fixed workspace and bounds",async()=>{
  let req;
  const r=await runOpenHandsCommand("openhands.start",{task:"Analyze this repository but make no changes"},deps(async(url,opts)=>{
    assert.equal(url,"http://127.0.0.1:18080/api/conversations");
    assert.equal(opts.method,"POST");
    req=JSON.parse(opts.body);
    return response({id,title:"Started",execution_status:"idle"});
  }));
  assert.equal(r.id,id);
  assert.equal(req.confirmation_policy.kind,"AlwaysConfirm");
  assert.equal(req.workspace.working_dir,"/projects/mcp-coordination-lab");
  assert.equal(req.max_iterations,20);
  assert.equal(req.initial_message.content[0].text,"Analyze this repository but make no changes");
  assert.equal(Object.hasOwn(req,"agent_settings"),false);
});
test("stop and result restrict uuid and whitelist outputs",async()=>{
  const commands=[];
  const mock=async(url,opts)=>{commands.push([url,opts.method]);return url.endsWith("agent_final_response")?response({response:"finished",internal_note:"not-returned"}):response({success:true,details:{internal_note:"hidden"}});};
  assert.deepEqual(await runOpenHandsCommand("openhands.result",{conversation_id:id},deps(mock)),{conversation_id:id,response:"finished"});
  assert.deepEqual(await runOpenHandsCommand("openhands.stop",{conversation_id:id},deps(mock)),{conversation_id:id,stop_requested:true});
  assert.equal(commands[1][1],"POST");
  await assert.rejects(runOpenHandsCommand("openhands.stop",{conversation_id:"../../etc/passwd"},deps(mock)),/invalid_conversation_id/);
});
test("no auth fails closed before request",async()=>{
  await assert.rejects(runOpenHandsCommand("openhands.list",{},deps(async()=>{throw Error("must not call");},{readKey:async()=>{throw Error("missing");}})),/openhands_auth_unconfigured/);
});
test("malformed inputs and unknown commands fail closed",async()=>{
  const d=deps(async()=>response({status:"ok"}));
  await assert.rejects(runOpenHandsCommand("openhands.list",{limit:1000},d),/invalid_limit/);
  await assert.rejects(runOpenHandsCommand("openhands.start",{task:"x"},d),/invalid_task/);
  await assert.rejects(runOpenHandsCommand("openhands.unsupported",{},d),/openhands_operation_denied/);
});
test("auth errors never expose upstream response or token",async()=>{
  const r=runOpenHandsCommand("openhands.list",{},deps(async()=>response({detail:"API key super-secret-machine-auth-key"},401)));
  await assert.rejects(r,(e)=>e.message==="openhands_auth_denied");
});
test("large responses are rejected",async()=>{
  const body={items:[],payload:"x".repeat(131200)};
  await assert.rejects(runOpenHandsCommand("openhands.list",{},deps(async()=>response(body))),/openhands_response_too_large/);
});
