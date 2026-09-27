#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeManagedAdminTicket, verifyManagedAdminTicket, type ManagedAdminTicketV1 } from "./managed-admin-ticket.js";
import { MANAGED_ADMIN_DEFAULT_CWDS, MANAGED_ADMIN_DEFAULT_PROGRAMS, MANAGED_ADMIN_HARD_DENY } from "./managed-admin-policy.js";

type Json = Record<string, unknown>;
const SOCKET = process.env.WANDORA_ADMIN_BROKER_SOCKET ?? "/run/wandora-ops-admin/admin.sock";
const PUBLIC_KEY_FILE = process.env.WANDORA_ADMIN_AUTHORITY_PUBLIC_KEY ?? "/etc/wandora/managed-admin-public.pem";
const AGENT_STATE = process.env.WANDORA_AGENT_STATE ?? "/var/lib/wandora-ops-agent/device.json";
const REPLAY_FILE = process.env.WANDORA_ADMIN_REPLAY_FILE ?? "/var/lib/wandora-ops-admin/replay.json";
const ROOTS = (process.env.WANDORA_ADMIN_CWDS ?? MANAGED_ADMIN_DEFAULT_CWDS.join(","))
  .split(",").map((x) => x.trim()).filter(Boolean);
const PROGRAMS = new Set((process.env.WANDORA_ADMIN_PROGRAMS ?? MANAGED_ADMIN_DEFAULT_PROGRAMS.join(","))
  .split(",").map((x) => x.trim()).filter(Boolean));
const HARD_DENY = new Set<string>(MANAGED_ADMIN_HARD_DENY);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = Math.min(Math.max(Number(process.env.WANDORA_ADMIN_MAX_OUTPUT_BYTES ?? 1024 * 1024), 64 * 1024), 4 * 1024 * 1024);
const CLOCK_SKEW_MS = 30_000;

interface ReplayState { nonces: Record<string, number>; }

function fail(socket: net.Socket, code: string, message: string): void {
  socket.end(JSON.stringify({ ok:false,error:{code,message} })+"\n");
}
function reply(socket: net.Socket, result: Json): void {
  socket.end(JSON.stringify({ ok:true,result })+"\n");
}
function readDeviceId(): string {
  const x=JSON.parse(fs.readFileSync(AGENT_STATE,"utf8")) as {device_id?:unknown};
  const id=String(x.device_id??"");
  if(!/^dev_[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("managed_admin_device_state_invalid");
  return id;
}
function realRoots(): string[] {
  return ROOTS.map((root)=>fs.realpathSync(root).replace(/\/+$/,""));
}
function cwdAllowed(cwd: string): string {
  const real=fs.realpathSync(cwd).replace(/\/+$/,"");
  const ok=realRoots().some((root)=>real===root||real.startsWith(root+"/"));
  if(!ok) throw new Error("managed_admin_cwd_not_allowed");
  return real;
}
function loadReplay(now=Date.now()): ReplayState {
  let state:ReplayState={nonces:{}};
  try{
    const raw=JSON.parse(fs.readFileSync(REPLAY_FILE,"utf8")) as ReplayState;
    if(raw&&raw.nonces&&typeof raw.nonces==="object") state={nonces:{...raw.nonces}};
  }catch{}
  for(const [nonce,expires] of Object.entries(state.nonces)){
    if(!Number.isFinite(expires)||expires<now-60_000) delete state.nonces[nonce];
  }
  return state;
}
function persistReplay(state:ReplayState): void {
  fs.mkdirSync(path.dirname(REPLAY_FILE),{recursive:true,mode:0o700});
  const tmp=REPLAY_FILE+".tmp-"+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(state),{encoding:"utf8",mode:0o600});
  fs.renameSync(tmp,REPLAY_FILE);
  try{fs.chmodSync(REPLAY_FILE,0o600);}catch{}
}
function consumeNonce(ticket:ManagedAdminTicketV1, now=Date.now()): void {
  const state=loadReplay(now);
  if(state.nonces[ticket.nonce]) throw new Error("managed_admin_ticket_replayed");
  state.nonces[ticket.nonce]=ticket.expires_at;
  persistReplay(state);
}
function validateLocalAuthority(ticket:ManagedAdminTicketV1, expectedDevice:string, now=Date.now()): string {
  if(ticket.device_id!==expectedDevice) throw new Error("managed_admin_wrong_device");
  if(ticket.issued_at>now+CLOCK_SKEW_MS) throw new Error("managed_admin_ticket_from_future");
  if(ticket.expires_at<now) throw new Error("managed_admin_ticket_expired");
  if(HARD_DENY.has(ticket.program)) throw new Error("managed_admin_program_hard_denied");
  if(!PROGRAMS.has(ticket.program)) throw new Error("managed_admin_program_not_allowed");
  return cwdAllowed(ticket.cwd);
}
async function execute(ticket:ManagedAdminTicketV1,cwd:string):Promise<Json>{
  const started=Date.now();
  return await new Promise<Json>((resolve)=>{
    const child=spawn(ticket.program,ticket.argv,{
      cwd,
      shell:false,
      stdio:["ignore","pipe","pipe"],
      env:{
        PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME:"/root",
        LANG:"C.UTF-8",
        TERM:"dumb",
      },
    });
    let stdout:Buffer<ArrayBufferLike>=Buffer.alloc(0),stderr:Buffer<ArrayBufferLike>=Buffer.alloc(0),truncated=false,timedOut=false;
    const append=(current:Buffer<ArrayBufferLike>,chunk:Buffer<ArrayBufferLike>):Buffer<ArrayBufferLike>=>{
      if(current.length>=MAX_OUTPUT_BYTES){truncated=true;return current;}
      if(current.length+chunk.length>MAX_OUTPUT_BYTES){
        truncated=true;
        return Buffer.concat([current,chunk.subarray(0,MAX_OUTPUT_BYTES-current.length)]);
      }
      return Buffer.concat([current,chunk]);
    };
    child.stdout.on("data",(c:Buffer)=>{stdout=append(stdout,c);});
    child.stderr.on("data",(c:Buffer)=>{stderr=append(stderr,c);});
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},ticket.timeout_ms);
    child.on("error",(err)=>{
      clearTimeout(timer);
      resolve({code:null,stdout:"",stderr:err.message,duration_ms:Date.now()-started,truncated,timed_out:false});
    });
    child.on("close",(code)=>{
      clearTimeout(timer);
      resolve({
        code,
        stdout:stdout.toString("utf8"),
        stderr:stderr.toString("utf8"),
        duration_ms:Date.now()-started,
        truncated,
        timed_out:timedOut,
      });
    });
  });
}

const publicKeyPem=fs.readFileSync(PUBLIC_KEY_FILE,"utf8");
const expectedDevice=readDeviceId();
fs.mkdirSync(path.dirname(SOCKET),{recursive:true,mode:0o750});
try{fs.unlinkSync(SOCKET);}catch{}

const server=net.createServer((socket)=>{
  socket.setEncoding("utf8");
  let data="";
  let handled=false;
  socket.on("data",(chunk)=>{
    if(handled)return;
    data+=chunk;
    if(Buffer.byteLength(data,"utf8")>MAX_REQUEST_BYTES){handled=true;fail(socket,"REQUEST_TOO_LARGE","request too large");return;}
    const nl=data.indexOf("\n");
    if(nl<0)return;
    handled=true;
    void (async()=>{
      let raw:Json;
      try{raw=JSON.parse(data.slice(0,nl)) as Json;}catch{fail(socket,"INVALID_JSON","invalid json");return;}
      let ticket:ManagedAdminTicketV1;
      try{ticket=normalizeManagedAdminTicket(raw.ticket);}catch(e){fail(socket,"INVALID_TICKET",e instanceof Error?e.message:String(e));return;}
      const signature=String(raw.signature??"");
      if(!verifyManagedAdminTicket(ticket,signature,publicKeyPem)){fail(socket,"INVALID_SIGNATURE","managed admin signature invalid");return;}
      let cwd:string;
      try{cwd=validateLocalAuthority(ticket,expectedDevice);}catch(e){fail(socket,"CAPABILITY_DENIED",e instanceof Error?e.message:String(e));return;}
      try{consumeNonce(ticket);}catch(e){fail(socket,"REPLAY_DENIED",e instanceof Error?e.message:String(e));return;}
      const result=await execute(ticket,cwd);
      process.stdout.write(JSON.stringify({ts:new Date().toISOString(),event:"managed_admin_exec",target_id:ticket.target_id,device_id:ticket.device_id,program:ticket.program,nonce:ticket.nonce,code:result.code,timed_out:result.timed_out===true})+"\n");
      reply(socket,{...result,program:ticket.program,target_id:ticket.target_id,nonce:ticket.nonce});
    })().catch((e)=>fail(socket,"BROKER_ERROR",e instanceof Error?e.message:String(e)));
  });
});

server.listen(SOCKET,()=>{
  fs.chmodSync(SOCKET,0o660);
  process.stdout.write("MANAGED_ADMIN_BROKER=LISTENING socket="+SOCKET+" device_id="+expectedDevice+"\n");
});
