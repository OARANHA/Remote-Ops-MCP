import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve('.ci-dsh-reviewed');
assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 '9c1ac05bf9a0a3fa2ef9f95a3248f156c3fa5d15');
const {validateOperationalHostConfig,startOperationalReadHost}=await import(pathToFileURL(join(root,'deploy/mcp/operational-host.mjs')));
const base={version:1,enabled:true,issuer:'https://id.wandora.com.br/realms/deepharness',
 resource:'https://dsh-mcp.wandora.com.br/mcp',backendPort:3443,
 allowedOrigins:['https://chatgpt.com','https://chatgpt-mtls-proxy.invalid']};
const platformAdmin={enabled:true,workspaceParent:'/data/dsh/projetos',
 replayFile:'/data/dsh/wandora-platform/replay.json',allowedActions:['workspace.list'],
 clientFingerprintSha256:Array(32).fill('ab').join(':'),exclusiveReplayWriter:true};
test('runtime overlay touches only three reviewed launcher/listener files',()=>{
 assert.deepEqual(execFileSync('git',['-C',root,'diff','--name-only'],{encoding:'utf8'}).trim().split('\n').sort(),
  ['deploy/mcp/run-operational.mjs','deploy/mcp/operational-host.mjs','deploy/mcp/private-read-listener.mjs'].sort());
});
test('runtime preserves V1 defaults and snapshots explicit V2 local authority',()=>{
 assert.deepEqual(validateOperationalHostConfig(base),base);
 assert.deepEqual(validateOperationalHostConfig({...base,platformAdmin:{enabled:false}}).platformAdmin,{enabled:false});
 const result=validateOperationalHostConfig({...base,platformAdmin});
 platformAdmin.allowedActions.push('session.list');
 assert.deepEqual(result.platformAdmin.allowedActions,['workspace.list']);platformAdmin.allowedActions.pop();
});
test('runtime rejects incomplete, fabricated or broad host authority',()=>{
 for(const patch of [{allowedActions:[]},{allowedActions:['shell']},{exclusiveReplayWriter:false},
  {workspaceParent:'/etc'},{replayFile:'/tmp/replay'},{enabled:false},
  {clientFingerprintSha256:'bad'},{other:true}])
  assert.throws(()=>validateOperationalHostConfig({...base,platformAdmin:{...platformAdmin,...patch}}));
});
test('readiness is computed and emitted even when the operational Context has no logger',async()=>{
 const previous=console.info,events=[];let inspections=0;
 console.info=value=>events.push(JSON.parse(value));
 try{
  const ctx={effect(){}};
  await startOperationalReadHost(base,{
   Pool:class{on(){}async end(){}},assertAuthoritativePgReadPool:async()=>{},
   createAuthoritativePgReadQuery:()=>()=>{},createDiscovery:()=>({get:async()=>{}}),
   loadLayeredEnv:()=>({}),inspectPlatformServices:actual=>{
    assert.equal(actual,ctx);inspections++;
    return {ready:true,directoryBrowse:true,services:{workspaceRegistry:true},secret:'MUST_NOT_APPEAR'};
   },sdk:{},
  },{
   readFile:async name=>name.endsWith('db-password')?'a'.repeat(64):Buffer.from('TLS fixture'),
   lookup:async name=>[{address:name==='deepharness-web-edge'?'172.19.0.12':'172.30.0.2'}],
   boot:async()=>({ctx,service:{}}),listen:async()=>({}),
  });
  assert.equal(inspections,1);assert.equal(events.length,1);
  assert.equal(events[0].event,'DSH_PLATFORM_HOST_READINESS');
  assert.equal(events[0].ready,true);
  assert.ok(!JSON.stringify(events).includes('MUST_NOT_APPEAR'));
 }finally{console.info=previous;}
});
test('existing host passes exact Context to V2 once, and keeps V1 when optional V2 cannot initialize',async()=>{
 for(const fail of [false,true]){
  let warnings=0,builds=0,listener;
  const ctx={effect(){},logger:{warn:()=>{warnings++;}}};
  const handle={handle(){},dispose(){}};
  const deps={Pool:class{on(){}async end(){}},assertAuthoritativePgReadPool:async()=>{},
   createAuthoritativePgReadQuery:()=>()=>{},createDiscovery:()=>({get:async()=>{}}),
   loadLayeredEnv:()=>({}),createPlatformHandler:settings=>{
    builds++;assert.equal(settings.ctx,ctx);assert.deepEqual(settings.allowedActions,['workspace.list']);
    if(fail)throw Error('unavailable');return handle;
   },sdk:{}};
  await startOperationalReadHost({...base,platformAdmin},deps,{
   readFile:async name=>name.endsWith('db-password')?'a'.repeat(64):Buffer.from('TLS fixture'),
   lookup:async name=>[{address:name==='deepharness-web-edge'?'172.19.0.12':'172.30.0.2'}],
   boot:async()=>({ctx,service:{}}),listen:async options=>{listener=options;return {};},
  });
  assert.equal(builds,1);assert.equal(warnings,fail?1:0);
  assert.equal(listener.platformHandler,fail?undefined:handle);
  assert.equal(listener.port,3443);
 }
});
