/**
 * V2 private socket HTTP handler, no listener or deployment.
 * The hosting process MUST authenticate Unix peer credentials independently;
 * a header, cookie, body field, or proxy-forwarded identity is never enough.
 * Compose with composeDshPlatformPrivateHost, with an official DSH admin
 * adapter and separately provisioned private single-writer replay storage.
 */
import {validateDshPlatformEnvelope} from "./platform-admin-contract.mjs";
const ROUTE="/wandora/dsh-platform/v2";
const LIMIT=16_384;
const deny=()=>{throw Error("deepharness_platform_private_http_denied");};
export function createDshPlatformPrivateHttpHandler({relay,connectionForRequest,auditStage}={}){
 if(typeof relay?.dispatch!=="function"||typeof connectionForRequest!=="function")deny();
 return async function handle(req,res){
  let stage="request";
  const fail=(code=403)=>{
   if(!res.headersSent)res.writeHead(code,{"content-type":"application/json","cache-control":"no-store"});
   res.end(JSON.stringify({error:"deepharness_platform_private_unavailable"}));
  };
  try{
   if(req.method!=="POST"||req.url!==ROUTE||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"]??""))||
      req.headers["content-encoding"]!==undefined) return fail(404);
   stage="peer";
   const connection=await connectionForRequest(req);
   if(!connection) return fail();
   stage="body";
   let count=0;const chunks=[];
   for await(const chunk of req){
    const bytes=Buffer.from(chunk);count+=bytes.length;
    if(count>LIMIT)return fail(413);
    chunks.push(bytes);
   }
   let incoming;
   try{incoming=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return fail(400);}
   stage="contract";
   const envelope=validateDshPlatformEnvelope(incoming);
   // relay.dispatch authenticates the trusted connection again on every call.
   stage="upstream";
   const result=await relay.dispatch(connection,envelope);
   stage="response";
   const body=JSON.stringify({result});
   if(Buffer.byteLength(body,"utf8")>262144)return fail(500);
   res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
   res.end(body);
  }catch{
   // Audit only fixed labels, without request data, connection identities or error text.
   try{auditStage?.(stage);}catch{}
   return fail();
  }
 };
}
