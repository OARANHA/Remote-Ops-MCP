import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDshPrivateBridgeClient,createDshMtlsRequester,DSH_BRIDGE_HOST,DSH_BRIDGE_PORT,DSH_BRIDGE_PATH} from "./private-bridge-client.mjs";

function openssl(cwd,args){
  execFileSync("openssl",args,{cwd,stdio:"ignore"});
}

test("fixed bridge client completes a real pinned mutual-TLS request and rejects a wrong pin",{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"dsh-mtls-integration-"));
  let server;
  try{
    openssl(dir,["req","-x509","-newkey","rsa:2048","-nodes","-keyout","ca.key","-out","ca.pem",
      "-subj","/CN=DSH bridge integration CA","-days","1"]);
    openssl(dir,["req","-newkey","rsa:2048","-nodes","-keyout","server.key","-out","server.csr",
      "-subj","/CN=deepharness-mcp-backend"]);
    await (await import("node:fs/promises")).writeFile(join(dir,"server.ext"),
      "subjectAltName=DNS:deepharness-mcp-backend\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
    openssl(dir,["x509","-req","-in","server.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial",
      "-out","server.pem","-days","1","-extfile","server.ext"]);
    openssl(dir,["req","-newkey","rsa:2048","-nodes","-keyout","client.key","-out","client.csr",
      "-subj","/CN=Remote-Ops integration client"]);
    await (await import("node:fs/promises")).writeFile(join(dir,"client.ext"),
      "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
    openssl(dir,["x509","-req","-in","client.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial",
      "-out","client.pem","-days","1","-extfile","client.ext"]);

    const ca=await readFile(join(dir,"ca.pem"));
    const serverCert=await readFile(join(dir,"server.pem"));
    server=https.createServer({key:await readFile(join(dir,"server.key")),cert:serverCert,ca,
      requestCert:true,rejectUnauthorized:true},async(req,res)=>{
      assert.equal(req.method,"POST");
      assert.equal(req.url,DSH_BRIDGE_PATH);
      assert.equal(req.socket.authorized,true);
      const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(body,{operation:"sendLeadInstruction",workspaceId:"lab",leadSessionId:"lead-lab",
        requestId:"4db3b83c-5abc-4aa3-9270-9715e3d34e38",text:"synthetic mTLS canary"});
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      res.end(JSON.stringify({result:{accepted:true,requestId:body.requestId}}));
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const address=server.address();assert.ok(address&&typeof address==="object");
    const fingerprint=serverCert.toString("utf8");
    const {X509Certificate}=await import("node:crypto");
    const serverFingerprint=new X509Certificate(fingerprint).fingerprint256;
    let transportError;
    const httpsModule={request(options,callback){
      assert.equal(options.hostname,DSH_BRIDGE_HOST);
      assert.equal(options.port,DSH_BRIDGE_PORT);
      assert.equal(options.path,DSH_BRIDGE_PATH);
      const request=https.request({...options,port:address.port,
        lookup:(_host,lookupOptions,callback)=>{
          if(typeof lookupOptions==="function"){callback=lookupOptions;lookupOptions={};}
          if(lookupOptions?.all)callback(null,[{address:"127.0.0.1",family:4}]);
          else callback(null,"127.0.0.1",4);
        }},callback);
      request.once("error",error=>{transportError=error.message;});
      return request;
    }};
    const postJson=createDshMtlsRequester({ca,cert:await readFile(join(dir,"client.pem")),
      key:await readFile(join(dir,"client.key")),serverFingerprintSha256:serverFingerprint,httpsModule});
    const client=createDshPrivateBridgeClient({postJson});
    try {
      assert.deepEqual(await client.sendLeadInstruction({workspaceId:"lab",leadSessionId:"lead-lab",
        requestId:"4db3b83c-5abc-4aa3-9270-9715e3d34e38",text:"synthetic mTLS canary"}),
      {accepted:true,requestId:"4db3b83c-5abc-4aa3-9270-9715e3d34e38"});
    } catch (error) { error.message += ` (transport: ${transportError??"unknown"})`; throw error; }

    const wrongPin=createDshMtlsRequester({ca,cert:await readFile(join(dir,"client.pem")),
      key:await readFile(join(dir,"client.key")),serverFingerprintSha256:"00:".repeat(31)+"00",httpsModule});
    await assert.rejects(wrongPin({operation:"listTeams",workspaceId:"lab"}),/unavailable/i);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
