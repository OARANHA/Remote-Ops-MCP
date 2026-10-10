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
test("start resolves encrypted Canvas settings without exposing secrets",async()=>{
  const secret="ciphertext-not-a-plaintext-key";
  let req, requests=0;
  const r=await runOpenHandsCommand("openhands.start",{task:"Reply with the synthetic canary marker"},deps(async(url,opts)=>{
    requests++;
    if(url.endsWith("/api/settings")) {
      assert.equal(opts.method,"GET");
      assert.equal(opts.headers["X-Expose-Secrets"],"encrypted");
      assert.equal(opts.headers["X-Session-API-Key"],"super-secret-machine-auth-key");
      assert.equal(opts.redirect,"error");
      return response({agent_settings:{agent_kind:"openhands",llm:{model:"qwen3",api_key:secret}},active_agent_profile_id:null});
    }
    assert.equal(url,"http://127.0.0.1:18080/api/conversations");
    assert.equal(opts.method,"POST");
    assert.equal(opts.headers["X-Expose-Secrets"],undefined);
    req=JSON.parse(opts.body);
    return response({id,title:"Started",execution_status:"idle"});
  }));
  assert.equal(requests,2);
  assert.equal(r.id,id);
  assert.equal(JSON.stringify(r).includes(secret),false);
  assert.equal(req.secrets_encrypted,true);
  assert.equal(req.agent_settings.llm.api_key,secret);
  assert.equal(req.agent_settings.llm.model,"qwen3");
  assert.equal(req.confirmation_policy.kind,"AlwaysConfirm");
  assert.deepEqual(req.workspace,{kind:"LocalWorkspace",working_dir:"/projects/mcp-coordination-lab"});
  assert.equal(req.max_iterations,20);
  assert.equal(req.worktree,false);
  assert.equal(req.initial_message.run,true);
  assert.equal(req.initial_message.content[0].text,"Reply with the synthetic canary marker");
});

test("start prefers an active saved profile and does not forward settings",async()=>{
  const profile="22222222-2222-4222-8222-222222222222";
  let req;
  const r=await runOpenHandsCommand("openhands.start",{task:"Test without modifying files"},deps(async(url,opts)=>{
    if(url.endsWith("/api/settings"))
      return response({active_agent_profile_id:profile,agent_settings:{llm:{model:"qwen3",api_key:"ciphertext"}}});
    req=JSON.parse(opts.body);
    return response({id,title:"Profile",execution_status:"idle"});
  }));
  assert.equal(r.id,id);
  assert.equal(req.agent_profile_id,profile);
  assert.equal("agent_settings" in req,false);
  assert.equal("secrets_encrypted" in req,false);
  assert.equal(req.confirmation_policy.kind,"AlwaysConfirm");
});

test("start fails closed before POST when model settings are missing or malformed",async()=>{
  for(const settings of [{},{agent_settings:{}},{agent_settings:{llm:{}}},{active_agent_profile_id:"invalid",agent_settings:{llm:{model:"qwen3"}}}]) {
    let posts=0;
    await assert.rejects(runOpenHandsCommand("openhands.start",{task:"Synthetic canary task"},deps(async(url)=>{
      if(url.endsWith("/api/settings"))return response(settings);
      posts++;return response({id});
    })),/openhands_agent_settings_unavailable/);
    assert.equal(posts,0);
  }
});

test("start never leaks upstream settings errors or credentials",async()=>{
  const secret="very-private-key-material";
  let posts=0;
  await assert.rejects(runOpenHandsCommand("openhands.start",{task:"Synthetic canary task"},deps(async(url)=>{
    if(url.endsWith("/api/settings")) return response({detail:secret},503);
    posts++;return response({id});
  })),(error)=>error.message==="openhands_agent_settings_unavailable" && !error.message.includes(secret));
  assert.equal(posts,0);
  await assert.rejects(runOpenHandsCommand("openhands.start",{task:"Synthetic canary task"},deps(async(url)=>{
    if(url.endsWith("/api/settings"))return response({detail:secret},401);
    posts++;return response({id});
  })),(error)=>error.message==="openhands_auth_denied");
  assert.equal(posts,0);
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

test("events: bounded authenticated read returns ONLY safe metadata", async () => {
  const privateText = "PRIVATE_PROFILE_PROMPT_AND_KEY_MUST_NOT_LEAK";
  const events = [
    {
      kind:"MessageEvent", source:"agent", id:"private-id",
      llm_message:{content:[{type:"text",text:`Reasoning ${privateText} <｜DSML｜tool_calls>...</｜DSML｜tool_calls>` }], reasoning_content:privateText},
    },
    {
      kind:"ActionEvent", source:"agent", tool_name:"terminal",
      tool_call:{name:"terminal", arguments:JSON.stringify({command:`echo ${privateText}`})},
      action:{command:`echo ${privateText}`}, thought:[{text:privateText}],
    },
    {
      kind:"ObservationEvent", source:"environment", tool_name:"terminal",
      observation:{content:privateText}, error:privateText,
    },
    {
      kind:"MessageEvent", source:"user", llm_message:{content:[{type:"text",text:"<｜DSML｜tool_calls>user input"}]},
    },
  ];
  const r = await runOpenHandsCommand("openhands.events", {conversation_id:id, limit:4}, deps(async(url, opts) => {
    assert.equal(url, `http://127.0.0.1:18080/api/conversations/${id}/events/search?limit=4`);
    assert.equal(opts.method, "GET");
    assert.equal(opts.headers["X-Session-API-Key"], "super-secret-machine-auth-key");
    assert.equal(opts.redirect, "error");
    return response({items:events,next_page_id:"cursor_A-1"});
  }));
  assert.deepEqual(r, {
    conversation_id:id,
    items:[
      {kind:"MessageEvent",source:"agent",tool_name:null,structured_tool_call:false,has_raw_dsml:true},
      {kind:"ActionEvent",source:"agent",tool_name:"terminal",structured_tool_call:true,has_raw_dsml:false},
      {kind:"ObservationEvent",source:"environment",tool_name:"terminal",structured_tool_call:false,has_raw_dsml:false},
      {kind:"MessageEvent",source:"user",tool_name:null,structured_tool_call:false,has_raw_dsml:false},
    ],
    next_page_id:"cursor_A-1",
  });
  const sanitized=JSON.stringify(r);
  assert.equal(sanitized.includes(privateText),false);
  assert.equal(sanitized.includes("command"),false);
  assert.equal(sanitized.includes("reasoning"),false);
  assert.equal(sanitized.includes("PRIVATE"),false);
});

test("events: pagination is restricted and source metadata cannot inject payloads", async () => {
  let calls=0;
  const r = await runOpenHandsCommand("openhands.events",{conversation_id:id,limit:1,page_id:"c_1=-"},deps(async(url)=>{
    calls++;
    assert.equal(url,`http://127.0.0.1:18080/api/conversations/${id}/events/search?limit=1&page_id=c_1%3D-`);
    return response({items:[{kind:"MessageEvent",source:"agent",
      tool_name:"API_KEY=secret", llm_message:{content:[{type:"text",text:"normal reply"}],tool_calls:[{function:{name:"terminal",arguments:"SENSITIVE"}}]}}],
      next_page_id:null});
  }));
  assert.equal(calls,1);
  assert.deepEqual(r.items[0],{kind:"MessageEvent",source:"agent",tool_name:null,structured_tool_call:true,has_raw_dsml:false});
  const noCall=deps(async()=>{throw Error("network must not be touched");});
  await assert.rejects(runOpenHandsCommand("openhands.events",{conversation_id:"../../etc/passwd"},noCall),/invalid_conversation_id/);
  for(const limit of [0,21,1.5,NaN]) {
    await assert.rejects(runOpenHandsCommand("openhands.events",{conversation_id:id,limit},noCall),/invalid_limit/);
  }
  for(const page_id of ["../../etc/passwd","?tools=all","a".repeat(257)]) {
    await assert.rejects(runOpenHandsCommand("openhands.events",{conversation_id:id,page_id},noCall),/invalid_page_id/);
  }
});

test("events: malformed pages, excess events, HTTP auth errors and oversized bodies fail closed",async()=>{
  const urlArgs={conversation_id:id,limit:1};
  for(const body of [{}, {items:{}}, {items:[{},{}]}, {items:[],next_page_id:"../../secret"}]) {
    await assert.rejects(runOpenHandsCommand("openhands.events",urlArgs,deps(async()=>response(body))),/invalid_openhands_response/);
  }
  const privateText="token-from-upstream-must-not-appear";
  const denial=runOpenHandsCommand("openhands.events",urlArgs,deps(async()=>response({detail:privateText},401)));
  await assert.rejects(denial,e=>e.message==="openhands_auth_denied" && !e.message.includes(privateText));
  const huge=runOpenHandsCommand("openhands.events",urlArgs,deps(async()=>response({items:[],payload:privateText.repeat(9000)})));
  await assert.rejects(huge,/openhands_response_too_large/);
});
