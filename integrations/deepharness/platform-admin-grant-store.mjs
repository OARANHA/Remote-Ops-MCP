/**
 * Independent V2 DeepHarness platform administration grant/receipt store.
 * This module does NOT install an admin route or grant permissions automatically.
 * Single process, single writer, file on the durable OAuth control-plane volume.
 * Replays after uncertain network failures require the separate host-side
 * durable replay gate (not supplied by this module).
 */
import {createHash,randomUUID,randomBytes} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const deny=(s="deepharness_platform_grant_denied")=>{throw Error(s);};
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const ACTIONS=new Set(["workspace.list","skills.list","workspace.create","workspace.rename",
  "session.list","team.member.read","session.create","team.member.create",
  "team.task.create","team.task.update"]);
const READ=new Set(["workspace.list","session.list","skills.list","team.member.read"]);
const MAX_BYTES=12*1024*1024,MAX_GRANTS=500,MAX_RECEIPTS=5000,MAX_RESULT=131072;
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const ident=x=>typeof x==="string"&&ID.test(x);
function identity(v){
  if(!obj(v)||![v.actor,v.clientId,v.sessionId].every(ident)||
    v.actor!=="oauth:"+v.clientId+":"+v.sessionId.slice(0,12))deny();
  return Object.freeze({actor:v.actor,clientId:v.clientId,sessionId:v.sessionId});
}
const hash=parts=>createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const principalKey=p=>hash([p.actor,p.clientId,p.sessionId]);
const receiptKey=(p,k)=>hash([p.actor,p.clientId,p.sessionId,k]);
const empty=()=>({version:2,grants:{},receipts:{}});
function bounded(value){
  if(!obj(value))deny();
  let json;
  try{json=JSON.stringify(value);}catch{deny();}
  if(typeof json!=="string"||Buffer.byteLength(json,"utf8")>MAX_RESULT)deny();
  const result=JSON.parse(json);
  if(!obj(result))deny();
  return result;
}
function validate(state){
  if(!obj(state)||state.version!==2||!obj(state.grants)||!obj(state.receipts)||
    Object.keys(state.grants).length>MAX_GRANTS||
    Object.keys(state.receipts).length>MAX_RECEIPTS)deny();
  for(const [k,g] of Object.entries(state.grants)){
    if(!HASH.test(k)||!obj(g)||![g.actor,g.clientId,g.sessionId,g.revision].every(ident)||
      g.actor!=="oauth:"+g.clientId+":"+g.sessionId.slice(0,12)||
      g.rootScope!=="managed"||!Array.isArray(g.actions)||g.actions.length<1||
      g.actions.length>ACTIONS.size||g.actions.some(x=>!ACTIONS.has(x))||
      new Set(g.actions).size!==g.actions.length||
      !Number.isSafeInteger(g.updatedAt)||
      (g.revokedAt!==null&&!Number.isSafeInteger(g.revokedAt))||
      principalKey(identity(g))!==k)deny();
  }
  for(const [k,r] of Object.entries(state.receipts)){
    if(!HASH.test(k)||!obj(r)||
      ![r.actor,r.clientId,r.sessionId,r.grantRevision,
        r.action,r.requestId,r.receiptId].every(ident)||
      r.actor!=="oauth:"+r.clientId+":"+r.sessionId.slice(0,12)||
      !ACTIONS.has(r.action)||READ.has(r.action)||!UUID.test(r.requestId)||
      !HASH.test(r.payloadHash)||!["pending","accepted"].includes(r.status)||
      !Number.isSafeInteger(r.createdAt)||
      (r.acceptedAt!==null&&!Number.isSafeInteger(r.acceptedAt))||
      (r.status==="pending"&&r.result!==null)||
      (r.status==="accepted"&&!obj(r.result))||
      receiptKey(identity(r),r.requestId)!==k)deny();
    if(r.status==="accepted")bounded(r.result);
  }
  return state;
}
function persist(file,state){
  // load() rejects oversized files. Enforce the *same* bound before persisting
  // so a successful grant/receipt never makes the store unreadable on restart.
  const serialized=JSON.stringify(state)+"\n";
  if(Buffer.byteLength(serialized,"utf8")>MAX_BYTES)deny("deepharness_platform_store_full");
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=file+"."+process.pid+"."+randomBytes(8).toString("hex")+".tmp";
  let fd;
  try{
    fd=fs.openSync(temp,"wx",0o600);
    fs.writeFileSync(fd,serialized,"utf8");
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,file);
    const d=fs.openSync(dir,"r");try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }catch(e){
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temp);}catch{}
    throw e;
  }
}
function load(file){
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES)deny();
    return validate(JSON.parse(fs.readFileSync(file,"utf8")));
  }catch(e){
    if(e?.code==="ENOENT"){const state=empty();persist(file,state);return state;}
    deny("deepharness_platform_store_unavailable");
  }
}
/** Require a singleton instance. The authenticated admin console is separate. */
export function createPersistentDshPlatformGrantStore({file,now=Date.now,audit=()=>{}}={}){
  if(typeof file!=="string"||!path.isAbsolute(file)||file==="/"||
    typeof now!=="function"||typeof audit!=="function")deny();
  let state=load(file),faulted=false,tail=Promise.resolve();
  const log=(event,more={})=>{try{audit({event,at:now(),...more});}catch{}};
  const save=next=>{
    try{persist(file,validate(next));state=next;}
    catch(e){faulted=true;throw e;}
  };
  const current=p=>{
    if(faulted)deny("deepharness_platform_store_unavailable");
    const g=state.grants[principalKey(p)];
    return g&&g.revokedAt===null?g:null;
  };
  const serialize=fn=>{
    const guarded=()=>{if(faulted)deny("deepharness_platform_store_unavailable");return fn();};
    const result=tail.then(guarded,guarded);
    tail=result.then(()=>undefined,()=>undefined);
    return result;
  };
  return Object.freeze({
    async putGrant(input){
      return serialize(()=>{
        const p=identity(input),actions=input.actions;
        if(!Array.isArray(actions)||actions.length<1||actions.length>ACTIONS.size||
          actions.some(x=>!ACTIONS.has(x))||new Set(actions).size!==actions.length||
          (input.rootScope!==undefined&&input.rootScope!=="managed"))deny();
        const key=principalKey(p);
        if(!state.grants[key]&&Object.keys(state.grants).length>=MAX_GRANTS)deny("deepharness_platform_store_full");
        const grant={...p,rootScope:"managed",actions:[...actions].sort(),
          revision:randomUUID(),updatedAt:now(),revokedAt:null};
        save({...state,grants:{...state.grants,[key]:grant}});
        log("grant_put",{principal_hash:key,actions:grant.actions});
        return Object.freeze({revision:grant.revision,actions:[...grant.actions],rootScope:"managed"});
      });
    },
    async revokeGrant(input){
      return serialize(()=>{
        const p=identity(input),key=principalKey(p),g=current(p);
        if(!g)return false;
        save({...state,grants:{...state.grants,[key]:{
          ...g,revision:randomUUID(),updatedAt:now(),revokedAt:now(),
        }}});
        log("grant_revoke",{principal_hash:key});
        return true;
      });
    },
    async lookupCurrentGrant(input){
      const p=identity(input),g=current(p);
      return g?Object.freeze({...p,rootScope:"managed",revokedAt:null,
        revision:g.revision,actions:Object.freeze([...g.actions])}):null;
    },
    async withAuthorizedWrite(ctx,submit){
      return serialize(async()=>{
        const p=identity(ctx),g=current(p);
        if(!g||!ident(ctx.revision)||ctx.revision!==g.revision||
          !ACTIONS.has(ctx.action)||READ.has(ctx.action)||
          !g.actions.includes(ctx.action)||!UUID.test(ctx.requestId)||
          !HASH.test(ctx.payloadHash)||typeof submit!=="function"||
          (ctx.workspaceId!==null&&!ident(ctx.workspaceId)))deny();
        const key=receiptKey(p,ctx.requestId),prior=state.receipts[key];
        if(prior&&(prior.grantRevision!==g.revision||prior.action!==ctx.action||
          prior.payloadHash!==ctx.payloadHash))deny("deepharness_platform_replay_conflict");
        if(prior?.status==="accepted")return Object.freeze({
          accepted:true,authorizationCheckedAtCommit:true,
          grantRevision:g.revision,receiptId:prior.receiptId,duplicate:true,
          result:bounded(prior.result),
        });
        if(!prior&&Object.keys(state.receipts).length>=MAX_RECEIPTS)deny("deepharness_platform_store_full");
        const started=prior??{...p,action:ctx.action,requestId:ctx.requestId,
          payloadHash:ctx.payloadHash,grantRevision:g.revision,
          receiptId:"receipt_"+randomUUID(),status:"pending",
          createdAt:now(),acceptedAt:null,result:null};
        if(!prior)save({...state,receipts:{...state.receipts,[key]:started}});
        log(prior?"write_retry":"write_begin",{principal_hash:principalKey(p),
          receipt_hash:key,action:ctx.action});
        // The host must persist the derived remote requestId to safely replay
        // if this process crashes between remote success and accepted receipt.
        const result=bounded(await submit());
        const latest=current(p);
        if(!latest||latest.revision!==g.revision||
          !latest.actions.includes(ctx.action))deny();
        const done={...started,status:"accepted",acceptedAt:now(),result};
        save({...state,receipts:{...state.receipts,[key]:done}});
        log("write_accept",{principal_hash:principalKey(p),receipt_hash:key,
          action:ctx.action});
        return Object.freeze({accepted:true,authorizationCheckedAtCommit:true,
          grantRevision:g.revision,receiptId:done.receiptId,
          duplicate:false,result:bounded(result)});
      });
    },
  });
}

/** Shared by the authenticated Admin console and MCP loader in one process. */
let runtimeStore;
let runtimeFile;
export function getDshPlatformGrantStore({file}={}) {
  if(typeof file!=="string"||!path.isAbsolute(file)||file==="/")deny();
  const resolved=path.resolve(file);
  if(runtimeStore){
    if(resolved!==runtimeFile)deny("deepharness_platform_store_unavailable");
    return runtimeStore;
  }
  const created=createPersistentDshPlatformGrantStore({file:resolved});
  runtimeFile=resolved;
  runtimeStore=created;
  return created;
}
