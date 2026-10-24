/**
 * Host-side V2 durable replay fence. SINGLE writer/process on a persistent
 * private volume; no listener, grants or business methods are installed here.
 * An uncertain pending receipt is NEVER retried automatically: an operator
 * must reconcile with DSH before any recovery. This is at-most-once admission,
 * not proof of an exactly-once distributed commit.
 */
import fs from "node:fs";
import path from "node:path";
import {randomBytes} from "node:crypto";
const deny=(reason="deepharness_platform_replay_unavailable")=>{throw Error(reason);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const OPERATIONS=new Set(["createWorkspace","renameWorkspace","createLeadSession",
  "createTeammate","createTeamTask","updateTeamTask"]);
const ACTIONS=Object.freeze({createWorkspace:"workspace.create",renameWorkspace:"workspace.rename",
 createLeadSession:"session.create",createTeammate:"team.member.create",
 createTeamTask:"team.task.create",updateTeamTask:"team.task.update"});
const MAX=8*1024*1024,RESULT=262144,RECEIPTS=2000;
const obj=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function detach(v){
 let s;try{s=JSON.stringify(v);}catch{deny();}
 if(typeof s!=="string"||Buffer.byteLength(s,"utf8")>RESULT)deny();
 let r;try{r=JSON.parse(s);}catch{deny();}
 if(!r||typeof r!=="object")deny();
 return r;
}
function validReceipt(r){
 return obj(r)&&UUID.test(r.requestId)&&OPERATIONS.has(r.operation)&&
  r.action===ACTIONS[r.operation]&&HASH.test(r.payloadHash)&&
  ["pending","committed"].includes(r.status)&&
  Number.isSafeInteger(r.createdAt)&&
  (r.status==="pending"?r.result===null:(obj(r.result)||Array.isArray(r.result)));
}
function validate(state){
 if(!obj(state)||state.version!==1||!obj(state.receipts)||
  Object.keys(state.receipts).length>RECEIPTS)deny();
 for(const [key,r] of Object.entries(state.receipts)){
  if(!UUID.test(key)||!validReceipt(r)||r.requestId!==key)deny();
  if(r.status==="committed")detach(r.result);
 }
 return state;
}
function persist(filename,state){
 const body=JSON.stringify(validate(state))+"\n";
 if(Buffer.byteLength(body,"utf8")>MAX)deny("deepharness_platform_replay_full");
 const dir=path.dirname(filename),tmp=filename+"."+process.pid+"."+randomBytes(8).toString("hex")+".tmp";
 let fd;
 try{
  fd=fs.openSync(tmp,"wx",0o600);
  fs.writeFileSync(fd,body,"utf8");fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(tmp,filename);
  const d=fs.openSync(dir,"r");try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
 }catch(e){if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}throw e;}
}
function load(filename){
 try{
  const st=fs.lstatSync(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX)deny();
  return validate(JSON.parse(fs.readFileSync(filename,"utf8")));
 }catch(e){
  if(e?.code==="ENOENT"){const state={version:1,receipts:{}};persist(filename,state);return state;}
  deny();
 }
}
export function createDshPlatformDurableReplay({file,now=Date.now}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||file==="/"||
    typeof now!=="function")deny();
 let state=load(file),faulted=false,tail=Promise.resolve();
 const save=next=>{
  try{persist(file,next);state=next;}catch(e){faulted=true;throw e;}
 };
 function withDurableReplay(ctx,call){
  const run=async()=>{
   if(faulted||!obj(ctx)||!UUID.test(ctx.requestId)||
    !OPERATIONS.has(ctx.operation)||ctx.action!==ACTIONS[ctx.operation]||
    !HASH.test(ctx.payloadHash)||typeof call!=="function")deny();
   const old=state.receipts[ctx.requestId];
   if(old){
    if(old.operation!==ctx.operation||old.action!==ctx.action||
      old.payloadHash!==ctx.payloadHash)deny("deepharness_platform_replay_conflict");
    if(old.status==="pending")deny("deepharness_platform_replay_uncertain");
    return {requestId:ctx.requestId,action:ctx.action,payloadHash:ctx.payloadHash,
      committed:true,duplicate:true,result:detach(old.result)};
   }
   if(Object.keys(state.receipts).length>=RECEIPTS)deny("deepharness_platform_replay_full");
   const pending={requestId:ctx.requestId,operation:ctx.operation,
    action:ctx.action,payloadHash:ctx.payloadHash,status:"pending",
    createdAt:now(),result:null};
   save({...state,receipts:{...state.receipts,[ctx.requestId]:pending}});
   // Persist pending BEFORE any official DSH mutation. On any fault, leave it
   // pending so network retries cannot duplicate a possibly committed write.
   const result=detach(await call());
   const committed={...pending,status:"committed",result};
   save({...state,receipts:{...state.receipts,[ctx.requestId]:committed}});
   return {requestId:ctx.requestId,action:ctx.action,payloadHash:ctx.payloadHash,
    committed:true,duplicate:false,result:detach(result)};
  };
  const result=tail.then(run,run);
  tail=result.then(()=>undefined,()=>undefined);
  return result;
 }
 return Object.freeze({withDurableReplay});
}
