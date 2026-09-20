import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"romcp-agent-channel-"));
process.env.STATE_FILE=path.join(tmp,"state.json");
process.env.AUTH_MODE="noauth";
process.env.TARGETS_FILE=path.resolve("config/targets.example.json");
const state=await import("./dist/state/store.js");
const gateway=await import("./dist/agent/gateway.js");
state.initStateStore();
const pair=state.createPairing({hostname:"mesh-test-host",agent_version:"2.0.0-test"});
const approved=state.approvePairingByCode(pair.code);
if(!approved) throw new Error("approval failed");
const claimed=state.claimPairing(pair.pairing_id,pair.poll_token);
if(claimed.status!=="paired") throw new Error("claim failed");
const server=http.createServer((_req,res)=>res.end("ok"));
gateway.attachAgentGateway(server);
await new Promise((resolve)=>server.listen(3120,"127.0.0.1",resolve));
const ws=new WebSocket("ws://127.0.0.1:3120/agent/connect",{headers:{authorization:"Bearer "+claimed.device_token}});
const welcome=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error("welcome timeout")),3000);
 ws.once("message",(data)=>{clearTimeout(timer);resolve(JSON.parse(data.toString()));});
 ws.once("error",reject);
});
if(welcome.type!=="welcome") throw new Error("no welcome");
console.log("AGENT_CHANNEL_CONNECT=PASS");
ws.send(JSON.stringify({type:"heartbeat",agent_version:"2.0.0-test",capabilities:["host.status"]}));
const ack=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error("ack timeout")),3000);
 ws.once("message",(data)=>{clearTimeout(timer);resolve(JSON.parse(data.toString()));});
});
if(ack.type!=="heartbeat_ack") throw new Error("no heartbeat ack");
console.log("AGENT_CHANNEL_HEARTBEAT=PASS");
state.revokeDevice(claimed.device.device_id);
gateway.disconnectAgentDevice(claimed.device.device_id);
const code=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error("close timeout")),3000);
 ws.once("close",(c)=>{clearTimeout(timer);resolve(c);});
});
if(code!==4003) throw new Error("wrong revoke close code "+code);
console.log("AGENT_CHANNEL_REVOKE=PASS");
server.close();
fs.rmSync(tmp,{recursive:true,force:true});
console.log("AGENT_MESH_CHANNEL_V1=GREEN");