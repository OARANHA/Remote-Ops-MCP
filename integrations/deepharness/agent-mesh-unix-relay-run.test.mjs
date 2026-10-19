import test from "node:test";
import assert from "node:assert/strict";
import {startDshUnixRelayRuntime} from "./agent-mesh-unix-relay-run.mjs";

const config={
  DSH_UNIX_RELAY_ENABLED:"1",
  DSH_UNIX_RELAY_WORKSPACE_ID:"lab-1",
  DSH_UNIX_RELAY_LEAD_SESSION_ID:"lead-1",
  DSH_BRIDGE_SERVER_FP_SHA256:"aa:".repeat(31)+"aa",
};
test("disabled or incomplete runtime performs zero I/O",async()=>{
  let reads=0,listen=0;
  const io={readFile:async()=>{reads++;throw Error("should not read");},
    startListener:async()=>{listen++;throw Error("should not listen");}};
  for(const env of [{},{...config,DSH_UNIX_RELAY_ENABLED:"0"},
    {...config,DSH_UNIX_RELAY_WORKSPACE_ID:"../bad"},
    {...config,DSH_BRIDGE_SERVER_FP_SHA256:"00"},
    {...config,DSH_UNIX_RELAY_LEAD_SESSION_ID:""}]){
    await assert.rejects(startDshUnixRelayRuntime({env,...io}),/startup_denied/);
  }
  assert.equal(reads,0);
  assert.equal(listen,0);
});
test("operator-only startup reads exactly three fixed paths before binding",async()=>{
  const paths=[];
  let composed;
  let launched;
  const listener={close:async()=>{},socketPath:"/run/wandora/deepharness-semantic/bridge.sock"};
  const actual=await startDshUnixRelayRuntime({
    env:config,
    readFile:async path=>{paths.push(path);return Buffer.from("test-pem");},
    createHandler:settings=>{composed=settings;return ()=>{};},
    startListener:async options=>{launched=options;return listener;},
  });
  assert.equal(actual,listener);
  assert.deepEqual(paths,[
    "/run/secrets/dsh-bridge-ca.pem",
    "/run/secrets/dsh-bridge-client-cert.pem",
    "/run/secrets/dsh-bridge-client-key.pem",
  ]);
  assert.equal(composed.workspaceId,"lab-1");
  assert.equal(composed.leadSessionId,"lead-1");
  assert.equal(composed.serverFingerprintSha256,config.DSH_BRIDGE_SERVER_FP_SHA256);
  assert.deepEqual(composed.tls.ca,Buffer.from("test-pem"));
  assert.equal(launched.enabled,true);
  assert.equal(typeof launched.handler,"function");
  assert.equal(Object.hasOwn(launched,"socketPath"),false);
});
test("missing, empty and excessive TLS material denies without opening a listener",async()=>{
  let called=0;
  for(const readFile of [
    async()=>{throw Error("missing");},
    async()=>Buffer.alloc(0),
    async()=>Buffer.alloc(32769),
    async()=> "not a buffer",
  ]){
    await assert.rejects(startDshUnixRelayRuntime({
      env:config,readFile,startListener:async()=>{called++;return {};},
      createHandler:()=>()=>{},
    }),/startup_denied/);
  }
  assert.equal(called,0);
});
test("handler construction failure denies and never binds",async()=>{
  let called=false;
  await assert.rejects(startDshUnixRelayRuntime({env:config,
    readFile:async()=>Buffer.from("data"),
    createHandler:()=>{throw Error("tls internals secret");},
    startListener:async()=>{called=true;return {};},
  }),/startup_denied/);
  assert.equal(called,false);
});
