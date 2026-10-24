import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as stores from './platform-admin-grant-store.mjs';
import {loadDshPlatformToolDefs} from './platform-admin-runtime.mjs';

test('platform loader is inactive by default and rejects noauth or mock activation', async()=>{
 const saved={...process.env};
 try {
  delete process.env.DSH_PLATFORM_MCP_ENABLED;
  assert.deepEqual(await loadDshPlatformToolDefs(),[]);
  process.env.DSH_PLATFORM_MCP_ENABLED='1';
  process.env.AUTH_MODE='noauth';
  await assert.rejects(loadDshPlatformToolDefs(),/runtime_unavailable/);
  process.env.AUTH_MODE='oauth';
  for(const value of ['1','true','TRUE']){
   process.env.MOCK_MODE=value;
   await assert.rejects(loadDshPlatformToolDefs(),/runtime_unavailable/);
  }
 } finally {
  for(const key of ['DSH_PLATFORM_MCP_ENABLED','AUTH_MODE','MOCK_MODE']){
   if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  }
 }
});

test('Admin and MCP share one V2 grant owner and observe revocation immediately', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-runtime-'));
 try {
  assert.equal(typeof stores.getDshPlatformGrantStore,'function');
  const file=join(dir,'platform.json');
  const admin=stores.getDshPlatformGrantStore({file});
  const mcp=stores.getDshPlatformGrantStore({file});
  assert.equal(admin,mcp);
  const principal={clientId:'client',sessionId:'session-0123456789abcdef',
   actor:'oauth:client:session-0123'};
  await admin.putGrant({...principal,actions:['workspace.list']});
  assert.deepEqual((await mcp.lookupCurrentGrant(principal)).actions,['workspace.list']);
  await admin.revokeGrant(principal);
  assert.equal(await mcp.lookupCurrentGrant(principal),null);
  assert.throws(()=>stores.getDshPlatformGrantStore({file:join(dir,'other.json')}),/unavailable/);
  assert.equal(existsSync(join(dir,'other.json')),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
