import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createDshMtlsRequester} from './private-bridge-client.mjs';
import * as relay from './agent-mesh-unix-relay.mjs';
import {startDshUnixRelayRuntime} from './agent-mesh-unix-relay-run.mjs';
const pin=Array(32).fill('ab').join(':');
test('platform protocol selects only the fixed existing private backend route',async()=>{
 let options;
 const post=createDshMtlsRequester({protocol:'platform-v2',ca:'ca',cert:'cert',key:'key',serverFingerprintSha256:pin,
  httpsModule:{request:o=>{options=o;throw Error('transport stop');}}});
 await assert.rejects(post({op:'deepharness.platform',args:{operation:'listWorkspaces'}}));
 assert.equal(options.path,'/wandora/dsh-platform/v2');assert.equal(options.hostname,'deepharness-mcp-backend');
 assert.equal(options.port,3443);assert.equal(options.rejectUnauthorized,true);
 options=undefined;
 await assert.rejects(post({op:'shell',args:{}}));assert.equal(options,undefined);
 assert.throws(()=>createDshMtlsRequester({protocol:'https://other',ca:'ca',cert:'cert',key:'key',serverFingerprintSha256:pin}));
});
test('platform Unix relay forwards exact envelope, refusing TCP and fabricated authority',async()=>{
 assert.equal(typeof relay.createDshPlatformUnixRelayHandler,'function');
 let calls=0;
 const handler=relay.createDshPlatformUnixRelayHandler({postJson:async envelope=>{
  calls++;assert.equal(envelope.op,'deepharness.platform');return [];
 }});
 async function call(socket={},body={op:'deepharness.platform',args:{operation:'listWorkspaces'}}){
  const req=Readable.from([JSON.stringify(body)]);Object.assign(req,{socket,method:'POST',url:'/wandora/dsh-platform/v2',headers:{'content-type':'application/json'}});
  const res={status:0,headersSent:false,writeHead(c){this.status=c;this.headersSent=true;},end(){}};
  await handler(req,res);return res.status;
 }
 assert.equal(await call(),200);assert.equal(calls,1);
 assert.equal(await call({remoteAddress:'127.0.0.1',remotePort:1234}),403);
 assert.equal(await call({}, {op:'deepharness.platform',args:{operation:'listWorkspaces'},actor:'admin'}),403);
 assert.equal(calls,1);
});
test('optional V2 relay reuses certificates and preserves V1 if V2 socket cannot start',async()=>{
 const env={DSH_UNIX_RELAY_ENABLED:'1',DSH_UNIX_RELAY_WORKSPACE_ID:'lab-1',DSH_UNIX_RELAY_LEAD_SESSION_ID:'lead-1',
  DSH_UNIX_RELAY_SOCKET_GID:'2201',DSH_BRIDGE_SERVER_FP_SHA256:pin,
  DSH_PLATFORM_RELAY_ENABLED:'1',DSH_PLATFORM_SOCKET_GID:'2201'};
 for(const fail of [false,true]){
  const paths=[];let reads=0,closed=0;
  const result=await startDshUnixRelayRuntime({env,readFile:async()=>{reads++;return Buffer.from('fixture');},
   createHandler:()=>()=>{},createPlatformHandler:()=>()=>{},
   startListener:async options=>{paths.push(options.socketPath??'V1');
    if(options.socketPath&&fail)throw Error('socket absent');return {close:async()=>{closed++;}};},
  });
  assert.equal(reads,3);
  assert.deepEqual(paths,['V1','/run/wandora/deepharness-platform/bridge.sock']);
  assert.equal(result.platformReady,!fail);await result.close();assert.equal(closed,fail?1:2);
 }
});
