import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAgentOperation} from './dist/agent/operations.js';
import * as advertisement from './dist/agent/deepharness-advertisement.js';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('existing MCP registry exposes ten V2 tools only with explicit configuration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-mcp-registry-'));
 try {
  const targets=join(dir,'targets.json');
  writeFileSync(targets,JSON.stringify({targets:[{id:'deepharness-platform-private',
   transport:'agent',environment:'development',capabilityProfile:'semantic-operator',
   enabled:true,deviceId:'dev_abcdefgh',allowedSemanticCapabilities:['deepharness.platform']}]}));
  const probe=`
   import {createServer} from './dist/server/mcp.js';
   import {Client} from '@modelcontextprotocol/sdk/client/index.js';
   import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
   import {loadRegistry} from './dist/config/targets.js';
   import {initStateStore} from './dist/state/store.js';
   initStateStore();loadRegistry();
   const server=await createServer({actor:'oauth:client:session-0123',clientId:'client',
    sessionId:'session-0123456789abcdef',requestId:'registry-test'});
   const client=new Client({name:'registry-test',version:'1'});
   const [a,b]=InMemoryTransport.createLinkedPair();
   await server.connect(a);await client.connect(b);
   const result=await client.listTools();
   console.log(JSON.stringify(result.tools.filter(t=>t.name.startsWith('dsh_')).map(t=>t.name)));
   await client.close();await server.close();
  `;
  const env={...process.env,AUTH_MODE:'oauth',MOCK_MODE:'0',
   DSH_SEMANTIC_ENABLED:'0',STATE_FILE:join(dir,'state.json'),
   TARGETS_FILE:targets,DSH_PLATFORM_GRANT_STATE_FILE:join(dir,'platform.json')};
  const run=flag=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],
   {cwd:process.cwd(),env:{...env,DSH_PLATFORM_MCP_ENABLED:flag},encoding:'utf8'}).trim().split('\n').at(-1));
  assert.deepEqual(run('0'),[]);
  assert.deepEqual(run('1').sort(),['dsh_list_workspaces','dsh_create_workspace',
   'dsh_rename_workspace','dsh_list_workspace_sessions','dsh_list_session_skills','dsh_list_team_member_states','dsh_create_lead_session',
   'dsh_create_teammate','dsh_create_team_task','dsh_update_team_task'].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'platform.json'),'utf8')).grants,{});
  writeFileSync(targets,JSON.stringify({targets:[{id:'unrelated-target',transport:'mock',enabled:true}]}));
  assert.deepEqual(run('1'),[],'V2 unavailable must preserve the existing MCP registry');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('platform operations reach their deny-by-default receiver, never generic execution',async()=>{
 delete process.env.DSH_PLATFORM_AGENT_ENABLED;
 const result=await executeAgentOperation({op:'deepharness.platform',args:{operation:'listWorkspaces'}});
 assert.equal(result.code,1);
 assert.equal(result.stderr,'deepharness_platform_receiver_unavailable');
});
test('platform capability requires opt-in, separate nonroot peer, group and strict socket',()=>{
 assert.equal(typeof advertisement.canAdvertiseDshPlatform,'function');
 const env={DSH_PLATFORM_AGENT_ENABLED:'1',DSH_PLATFORM_RELAY_UID:'2101',DSH_PLATFORM_SOCKET_GID:'2201'};
 const stat=p=>({uid:2101,gid:2201,mode:p.endsWith('bridge.sock')?0o660:0o2710,
  isSocket:()=>p.endsWith('bridge.sock'),isDirectory:()=>!p.endsWith('bridge.sock'),isSymbolicLink:()=>false});
 const identity=()=>({uid:1001,gid:1001,groups:[2201]});
 assert.equal(advertisement.canAdvertiseDshPlatform({env,stat,identity}),true);
 for(const invalid of [
  {env:{...env,DSH_PLATFORM_AGENT_ENABLED:'0'},stat,identity},
  {env,stat,identity:()=>({uid:0,gid:2201,groups:[]})},
  {env,stat,identity:()=>({uid:2101,gid:2201,groups:[]})},
  {env,stat,identity:()=>({uid:1001,gid:1001,groups:[]})},
  {env,stat:p=>({...stat(p),mode:0o777}),identity},
 ])assert.equal(advertisement.canAdvertiseDshPlatform(invalid),false);
});
