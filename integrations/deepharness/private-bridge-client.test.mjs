import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {createDshPrivateBridgeClient,createDshMtlsRequester,DSH_BRIDGE_HOST,DSH_BRIDGE_PORT,DSH_BRIDGE_PATH} from "./private-bridge-client.mjs";

test("only fixed semantic operations and strict bounded arguments can cross the bridge",async()=>{
  const calls=[],client=createDshPrivateBridgeClient({postJson:async request=>{calls.push(request);
    if(request.operation==="listTeams"||request.operation==="listTasks")return [];
    if(request.operation==="sendLeadInstruction")return {accepted:true,requestId:request.requestId};
    return {messages:[],hasMore:false};}});
  await client.listTeams({workspaceId:"ws-1"});
  await client.readLeadChat({workspaceId:"ws-1",leadSessionId:"lead-1",maxMessages:10});
  const key="4db3b83c-5abc-4aa3-9270-9715e3d34e38";
  assert.deepEqual(await client.sendLeadInstruction({workspaceId:"ws-1",leadSessionId:"lead-1",requestId:key,text:"go"}),
    {accepted:true,requestId:key});
  assert.deepEqual(calls[0],{operation:"listTeams",workspaceId:"ws-1"});
  assert.deepEqual(calls[1],{operation:"readLeadChat",workspaceId:"ws-1",leadSessionId:"lead-1",maxMessages:10});
  for(const invalid of [
    ()=>client.getTeamStatus({workspaceId:"ws-1",leadSessionId:"lead-1",operation:"shell"}),
    ()=>client.readLeadChat({workspaceId:"ws-1",leadSessionId:"lead-1",maxMessages:21}),
    ()=>client.sendLeadInstruction({workspaceId:"ws-1",leadSessionId:"lead-1",requestId:"bad",text:"go"}),
  ])await assert.rejects(invalid(),/unavailable/i);
});

test("mTLS requester fixes backend host, port and path and requires certificate material plus server pin",()=>{
  const options={ca:"ca",cert:"client cert",key:"client key",serverFingerprintSha256:"aa:".repeat(31)+"aa"};
  let requestOptions;
  const httpsModule={request(options,callback){requestOptions=options;throw Error("test stop");}};
  const post=createDshMtlsRequester({...options,httpsModule});
  assert.equal(typeof post,"function");
  assert.throws(()=>createDshMtlsRequester({...options,serverFingerprintSha256:"00"}),/unavailable/i);
  const pending=post({operation:"listTeams",workspaceId:"ws"});
  assert.deepEqual({host:requestOptions.hostname,port:requestOptions.port,path:requestOptions.path,method:requestOptions.method,
    rejectUnauthorized:requestOptions.rejectUnauthorized,servername:requestOptions.servername},
    {host:DSH_BRIDGE_HOST,port:DSH_BRIDGE_PORT,path:DSH_BRIDGE_PATH,method:"POST",rejectUnauthorized:true,servername:DSH_BRIDGE_HOST});
  return assert.rejects(pending,/unavailable/i);
});

test("accepts only a 200 JSON response from the pinned TLS peer",async()=>{
  async function callWith(peerFingerprint) {
    const httpsModule={request(options,callback){
      const request=new EventEmitter();request.options=options;request.setTimeout=()=>{};
      request.destroy=error=>{queueMicrotask(()=>request.emit("error",error));};
      request.end=()=>{
        const socket=new EventEmitter();socket.getPeerCertificate=()=>({fingerprint256:peerFingerprint});
        request.emit("socket",socket);socket.emit("secureConnect");
        if(peerFingerprint!=="11:".repeat(31)+"11")return;
        const response=Readable.from([Buffer.from(JSON.stringify({result:{accepted:true}}))]);
        response.statusCode=200;response.headers={"content-type":"application/json; charset=utf-8"};
        callback(response);
      };
      return request;
    }};
    const post=createDshMtlsRequester({ca:"ca",cert:"cert",key:"key",
      serverFingerprintSha256:"11:".repeat(31)+"11",httpsModule});
    return post({operation:"sendLeadInstruction",workspaceId:"ws",leadSessionId:"lead",
      requestId:"4db3b83c-5abc-4aa3-9270-9715e3d34e38",text:"go"});
  }
  assert.deepEqual(await callWith("11:".repeat(31)+"11"),{accepted:true});
  await assert.rejects(callWith("22:".repeat(31)+"22"),/unavailable/i);
});
