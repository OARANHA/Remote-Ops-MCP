/** Fixed mTLS client for the DSH semantic endpoint; no caller-controlled URL. */
import https from "node:https";
import {timingSafeEqual} from "node:crypto";

export const DSH_BRIDGE_HOST="deepharness-mcp-backend";
export const DSH_BRIDGE_PORT=3443;
export const DSH_BRIDGE_PATH="/wandora/dsh-bridge/v1";
const MAX_RESPONSE_BYTES=262_144;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const deny=()=>{throw Error("deepharness_private_bridge_unavailable");};
const obj=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const fingerprint=value=>typeof value==="string"?value.replaceAll(":","").toLowerCase():"";
const validPin=value=>/^[0-9a-f]{64}$/.test(fingerprint(value));
function exact(value,keys){
  if(!obj(value)||Object.keys(value).some(key=>!keys.includes(key)))deny();
  for(const key of keys)if(key!=="maxMessages"&&!Object.hasOwn(value,key))deny();
}
function safeId(value){if(typeof value!=="string"||!ID.test(value))deny();return value;}

export function createDshMtlsRequester({ca,cert,key,serverFingerprintSha256,timeoutMs=10_000,
  httpsModule=https}={}) {
  if(![ca,cert,key].every(value=>typeof value==="string"||Buffer.isBuffer(value))||
     ![ca,cert,key].every(value=>value.length>0)||!validPin(serverFingerprintSha256)||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30_000||
     typeof httpsModule?.request!=="function")deny();
  const expected=Buffer.from(fingerprint(serverFingerprintSha256),"hex");
  return async function postJson(payload) {
    const serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>16_384)deny();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const fail=()=>{if(!settled){settled=true;reject(Error("deepharness_private_bridge_unavailable"));}};
      let request;
      try {
        request=httpsModule.request({hostname:DSH_BRIDGE_HOST,port:DSH_BRIDGE_PORT,path:DSH_BRIDGE_PATH,
          method:"POST",agent:false,ca,cert,key,rejectUnauthorized:true,servername:DSH_BRIDGE_HOST,
          headers:{"content-type":"application/json","accept":"application/json",
            "content-length":Buffer.byteLength(serialized)}},response=>{
          if(response.statusCode!==200||typeof response.headers?.["content-type"]!=="string"||
             !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers["content-type"])||
             response.headers["content-encoding"]!==undefined) { response.destroy();fail();return; }
          const chunks=[];let size=0;
          response.on("data",chunk=>{
            size+=chunk.length;if(size>MAX_RESPONSE_BYTES){response.destroy();fail();return;}
            chunks.push(Buffer.from(chunk));
          });
          response.on("end",()=>{
            try {
              const result=JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if(!obj(result)||Object.keys(result).length!==1||!Object.hasOwn(result,"result"))throw Error();
              if(!settled){settled=true;resolve(result.result);}
            }catch{fail();}
          });
          response.on("error",fail);
        });
      } catch { fail();return; }
      request.on("socket",socket=>{
        socket.once("secureConnect",()=>{
          const peer=fingerprint(socket.getPeerCertificate?.()?.fingerprint256);
          const actual=/^[0-9a-f]{64}$/.test(peer)?Buffer.from(peer,"hex"):Buffer.alloc(32);
          if(!timingSafeEqual(actual,expected))request.destroy(Error("peer pin mismatch"));
        });
      });
      request.setTimeout?.(timeoutMs,()=>request.destroy(Error("request timeout")));
      request.on("error",fail);
      request.end(serialized);
    });
  };
}

export function createDshPrivateBridgeClient({postJson}={}) {
  if(typeof postJson!=="function")deny();
  async function call(operation,args) {
    const result=await postJson({operation,...args});
    return result;
  }
  return Object.freeze({
    async listTeams(input){exact(input,["workspaceId"]);const result=await call("listTeams",{workspaceId:safeId(input.workspaceId)});
      if(!Array.isArray(result))deny();return result;},
    async getTeamStatus(input){exact(input,["workspaceId","leadSessionId"]);const result=await call("getTeamStatus",{
      workspaceId:safeId(input.workspaceId),leadSessionId:safeId(input.leadSessionId)});if(!obj(result))deny();return result;},
    async listTasks(input){exact(input,["workspaceId","leadSessionId"]);const result=await call("listTasks",{
      workspaceId:safeId(input.workspaceId),leadSessionId:safeId(input.leadSessionId)});if(!Array.isArray(result))deny();return result;},
    async readLeadChat(input){exact(input,["workspaceId","leadSessionId","maxMessages"]);
      const maxMessages=input.maxMessages??50;
      if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>20)deny();
      const result=await call("readLeadChat",{workspaceId:safeId(input.workspaceId),
        leadSessionId:safeId(input.leadSessionId),maxMessages});if(!obj(result))deny();return result;},
    async sendLeadInstruction(input){exact(input,["workspaceId","leadSessionId","requestId","text"]);
      if(typeof input.requestId!=="string"||!UUID.test(input.requestId)||typeof input.text!=="string"||
         input.text.trim().length===0||Buffer.byteLength(input.text,"utf8")>4096||input.text.includes("\0"))deny();
      const result=await call("sendLeadInstruction",{workspaceId:safeId(input.workspaceId),
        leadSessionId:safeId(input.leadSessionId),requestId:input.requestId,text:input.text});
      if(result.accepted!==true||result.requestId!==input.requestId)deny();
      return {accepted:true,requestId:input.requestId};},
  });
}
