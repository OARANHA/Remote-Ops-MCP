/**
 * CI-only synthetic chain: Agent receiver -> AF_UNIX relay -> pinned mTLS
 * -> disposable in-process HTTPS responder. No DSH service or real Lead.
 * Test-only DNS/port substitution NEVER changes the production TLS client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import {X509Certificate} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,chmod,lstat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDshMtlsRequester,DSH_BRIDGE_HOST,DSH_BRIDGE_PORT,DSH_BRIDGE_PATH} from
  "./integrations/deepharness/private-bridge-client.mjs";
import {createDshAgentMeshUnixRelayHandler} from
  "./integrations/deepharness/agent-mesh-unix-relay.mjs";
import {executeDshAgentOperation} from "./dist/agent/deepharness.js";

const scope={workspaceId:"lab-1",leadSessionId:"lead-1"};
const requestId="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
const command=(operation,other={})=>({op:"deepharness.semantic",
  args:{operation,workspaceId:scope.workspaceId,...other}});
const denied=out=>{
  assert.equal(out.code,1);
  assert.equal(out.stdout,"");
  assert.equal(out.stderr,"deepharness_agent_mesh_unavailable");
};
function openssl(dir,args){execFileSync("openssl",args,{cwd:dir,stdio:"ignore"});}
async function ephemeralTls(dir){
  openssl(dir,["req","-x509","-newkey","rsa:2048","-nodes",
    "-keyout","ca.key","-out","ca.pem","-subj","/CN=DSH temporary test CA","-days","1"]);
  openssl(dir,["req","-newkey","rsa:2048","-nodes",
    "-keyout","server.key","-out","server.csr","-subj","/CN=deepharness-mcp-backend"]);
  await writeFile(join(dir,"server.ext"),
    "subjectAltName=DNS:deepharness-mcp-backend\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(dir,["x509","-req","-in","server.csr","-CA","ca.pem","-CAkey","ca.key",
    "-CAcreateserial","-out","server.pem","-days","1","-extfile","server.ext"]);
  openssl(dir,["req","-newkey","rsa:2048","-nodes",
    "-keyout","client.key","-out","client.csr","-subj","/CN=synthetic Agent Mesh relay"]);
  await writeFile(join(dir,"client.ext"),
    "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(dir,["x509","-req","-in","client.csr","-CA","ca.pem","-CAkey","ca.key",
    "-CAcreateserial","-out","client.pem","-days","1","-extfile","client.ext"]);
  return {
    ca:await readFile(join(dir,"ca.pem")),
    serverCert:await readFile(join(dir,"server.pem")),
    serverKey:await readFile(join(dir,"server.key")),
    clientCert:await readFile(join(dir,"client.pem")),
    clientKey:await readFile(join(dir,"client.key")),
  };
}
test("synthetic Agent Mesh -> Unix -> actual pinned mutual TLS with a wrong-pin rejection",
  {timeout:30000},async()=>{
  // CI runner is a nonroot user. Host UID/GID values are never invented.
  assert.ok(process.getuid()>0&&process.getgid()>0);
  const dir=await mkdtemp(join(tmpdir(),"dsh-unix-mtls-chain-"));
  const socket=join(dir,"bridge.sock");
  let backend,unix;
  try{
    await chmod(dir,0o700);
    const certificates=await ephemeralTls(dir);
    const received=[];
    backend=https.createServer({
      key:certificates.serverKey,cert:certificates.serverCert,ca:certificates.ca,
      requestCert:true,rejectUnauthorized:true,
    },async(req,res)=>{
      assert.equal(req.method,"POST");
      assert.equal(req.url,DSH_BRIDGE_PATH);
      assert.equal(req.socket.authorized,true);
      const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received.push(input);
      const result=input.operation==="listTeams"?
        [{leadSessionId:"ungranted",members:[],tasks:[]},
          {leadSessionId:scope.leadSessionId,members:[],tasks:[]}]:
        input.operation==="getTeamStatus"?
          {leadSessionId:scope.leadSessionId,members:[],tasks:[]}:
        input.operation==="sendLeadInstruction"?
          {accepted:true,requestId:input.requestId}:null;
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({result}));
    });
    await new Promise((resolve,reject)=>{
      backend.once("error",reject);backend.listen(0,"127.0.0.1",resolve);
    });
    const addr=backend.address();
    assert.ok(addr&&typeof addr==="object");
    const httpsModule={request(options,callback){
      assert.equal(options.hostname,DSH_BRIDGE_HOST);
      assert.equal(options.servername,DSH_BRIDGE_HOST);
      assert.equal(options.port,DSH_BRIDGE_PORT);
      assert.equal(options.path,DSH_BRIDGE_PATH);
      assert.equal(options.rejectUnauthorized,true);
      // Override is local to this disposable test, never runtime configuration.
      return https.request({...options,port:addr.port,
        lookup:(_host,lookupOptions,done)=>{
          if(typeof lookupOptions==="function"){done=lookupOptions;lookupOptions={};}
          if(lookupOptions?.all)done(null,[{address:"127.0.0.1",family:4}]);
          else done(null,"127.0.0.1",4);
        }},callback);
    }};
    const goodPin=new X509Certificate(certificates.serverCert).fingerprint256;
    const makeRequester=pin=>createDshMtlsRequester({
      ca:certificates.ca,cert:certificates.clientCert,key:certificates.clientKey,
      serverFingerprintSha256:pin,httpsModule,timeoutMs:5000,
    });
    let upstream=makeRequester(goodPin);
    unix=http.createServer(createDshAgentMeshUnixRelayHandler({
      ...scope,postJson:payload=>upstream(payload),
    }));
    await new Promise((resolve,reject)=>{
      unix.once("error",reject);unix.listen(socket,resolve);
    });
    await chmod(socket,0o600);
    // The runner cannot impersonate two Linux UIDs. Only metadata is faked
    // for the receiver; the actual transport is a real AF_UNIX/mTLS chain.
    const relayUid=process.getuid()+1;
    const agentGid=process.getgid();
    const env={
      DSH_AGENT_MESH_ENABLED:"1",
      DSH_AGENT_MESH_WORKSPACE_ID:scope.workspaceId,
      DSH_AGENT_MESH_LEAD_SESSION_ID:scope.leadSessionId,
      DSH_AGENT_MESH_RELAY_UID:String(relayUid),
      DSH_AGENT_MESH_SOCKET_GID:String(agentGid),
    };
    async function syntheticOwnerStat(path){
      const s=await lstat(path);
      return {
        isDirectory:()=>s.isDirectory(),
        isSocket:()=>s.isSocket(),
        isSymbolicLink:()=>s.isSymbolicLink(),
        uid:relayUid,gid:agentGid,
        mode:(s.mode&~0o7777)|(s.isDirectory()?0o2710:0o660),
      };
    }
    const deps={env,socketPath:socket,lstat:syntheticOwnerStat};
    const teams=await executeDshAgentOperation(command("listTeams"),{},deps);
    assert.equal(teams.code,0);
    assert.deepEqual(JSON.parse(teams.stdout).map(t=>t.leadSessionId),[scope.leadSessionId]);
    const ack=await executeDshAgentOperation(command("sendLeadInstruction",{
      leadSessionId:scope.leadSessionId,requestId,text:"synthetic only, no model",
    }),{},deps);
    assert.equal(ack.code,0);
    assert.deepEqual(JSON.parse(ack.stdout),{accepted:true,requestId});
    assert.equal(received.length,2);
    assert.equal(received[1].operation,"sendLeadInstruction");
    assert.equal(received[1].workspaceId,scope.workspaceId);
    assert.equal(received[1].leadSessionId,scope.leadSessionId);
    // Wrong Lead is denied on the host even before opening HTTPS.
    denied(await executeDshAgentOperation(command("getTeamStatus",{
      leadSessionId:"another-lead",
    }),{},deps));
    assert.equal(received.length,2);
    upstream=makeRequester("00:".repeat(31)+"00");
    denied(await executeDshAgentOperation(command("getTeamStatus",{
      leadSessionId:scope.leadSessionId,
    }),{},deps));
    assert.equal(received.length,2);
  }finally{
    if(unix)await new Promise(resolve=>unix.close(resolve));
    if(backend)await new Promise(resolve=>backend.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
