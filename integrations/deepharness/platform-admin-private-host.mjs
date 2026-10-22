import {timingSafeEqual} from "node:crypto";
import {realpathSync} from "node:fs";
import path from "node:path";
import {validateDshPlatformEnvelope,actionForDshPlatformOperation} from "./platform-admin-contract.mjs";
import {createDshPlatformPrivateHttpHandler} from "./platform-admin-private-http-handler.mjs";
/**
 * Optional V2 host assembly. NO listener or tool registration.
 * The private transport passes an authenticated connection separately from
 * the user/model envelope. Durable replay remains on the DSH host only.
 */
import {createDshPlatformDurableReplay} from "./platform-admin-durable-replay.mjs";
import {createDshPlatformPrivateRelay} from "./platform-admin-private-relay.mjs";
import {createOfficialDshPlatformAdmin} from "./official-dsh-platform-admin.mjs";
import {assertDshPlatformHostReadiness} from "./platform-admin-host-readiness.mjs";

const deny=()=>{throw Error("deepharness_platform_host_composition_unavailable");};

/**
 * This factory must be constructed only inside the DSH private service.
 * replayFile must live on a durable, isolated, single-writer host volume.
 * authenticatePeer must validate the real mTLS or AF_UNIX peer credentials,
 * NOT a value supplied inside JSON. An absent dependency fails closed.
 */
export function composeDshPlatformPrivateHost({
 admin,services,workspaceParent,authorizeRead,withAuthorizedWrite,
 authenticatePeer,replayFile,verifiedOfficialServices,
 exclusiveReplayWriter,privateTransportAuthenticated,
}={}){
 // Bind the actual Cordis Context services; never emulate directory creation.
 // Host read/write authorization is mandatory and remains independent of the
 // OAuth gate in the gateway. No permissive callback is supplied here.
 if(services!==undefined){
  if(admin!==undefined||verifiedOfficialServices!==true||
     typeof services?.directoryPicker?.capability!=="function"||
     services.directoryPicker.capability()?.kind!=="browse"||
     typeof services?.agentTeams?.spawnTeammate!=="function")deny();
  admin=createOfficialDshPlatformAdmin({
   workspaceRegistry:services.workspaceRegistry,
   workspaceController:services.workspaceController,
   directoryPickerController:services.directoryPickerController,
   sessionController:services.sessionController,agentTeams:services.agentTeams,
   workspaceParent,authorizeRead,withAuthorizedWrite,
  });
 }
 assertDshPlatformHostReadiness({admin,authenticatePeer,replayFile,
  verifiedOfficialServices,exclusiveReplayWriter,privateTransportAuthenticated});
 const replay=createDshPlatformDurableReplay({file:replayFile});
 return createDshPlatformPrivateRelay({
  admin,authenticatePeer,
  withDurableReplay:(request,commit)=>
   replay.withDurableReplay(request,commit),
 });
}


/**
 * Concrete embedding in the EXISTING DSH private HTTPS listener.
 * Does not bind a port, start a second profile, provision OAuth or grant access.
 * allowedActions is separate operator-owned HOST authority, never request JSON.
 * The gateway still independently enforces the current human OAuth grants.
 */
const hostReplayOwners=new Set();
const originalService=value=>value?.[Symbol.for("cordis.original")]??value;
export function createDshPlatformExistingHostHandler({
 enabled=false,ctx,workspaceParent,replayFile,allowedActions,
 clientFingerprintSha256,exclusiveReplayWriter=false,
}={}){
 const actions=new Set(["workspace.list","workspace.create","workspace.rename",
  "session.list","session.create","team.member.create","team.task.create","team.task.update"]);
 if(enabled!==true||exclusiveReplayWriter!==true||
    typeof ctx?.get!=="function"||typeof ctx?.effect!=="function"||
    !Array.isArray(allowedActions)||allowedActions.length===0||
    allowedActions.some(a=>!actions.has(a))||new Set(allowedActions).size!==allowedActions.length||
    typeof clientFingerprintSha256!=="string"||
    !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(clientFingerprintSha256)||
    typeof workspaceParent!=="string"||typeof replayFile!=="string"||
    !path.isAbsolute(replayFile)||path.resolve(replayFile)!==replayFile||
    realpathSync(workspaceParent)!==workspaceParent||
    realpathSync(path.dirname(replayFile))!==path.dirname(replayFile))deny();
 const names=["workspaceRegistry","workspaceController","directoryPickerController",
  "directoryPicker","sessionController","agentTeams"];
 const services=Object.fromEntries(names.map(name=>[name,ctx[name]]));
 const originals=names.map(name=>originalService(services[name]));
 const readService=ctx.get("chatgptMcpRead");
 if(!readService||originals.some(value=>!value)||
    typeof services.directoryPicker?.capability!=="function"||
    services.directoryPicker.capability()?.kind!=="browse"||
    typeof services.agentTeams?.spawnTeammate!=="function"||hostReplayOwners.has(replayFile))deny();
 // Validate every official service method before touching persistent replay.
 createOfficialDshPlatformAdmin({...services,workspaceParent,authorizeRead:deny,withAuthorizedWrite:deny});
 const replay=createDshPlatformDurableReplay({file:replayFile});
 hostReplayOwners.add(replayFile);
 const permitted=new Set(allowedActions);
 const pin=Buffer.from(clientFingerprintSha256.replaceAll(":",""),"hex");
 let active=true;
 function authentic(connection){
  try{
   if(!active||ctx.get("chatgptMcpRead")!==readService||
      !names.every((name,i)=>originalService(ctx[name])===originals[i])||
      services.directoryPicker.capability()?.kind!=="browse"||
      connection?.encrypted!==true||connection.authorized!==true||
      connection.destroyed===true)return false;
   const fp=connection.getPeerCertificate?.()?.fingerprint256;
   if(typeof fp!=="string"||!/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(fp))return false;
   return timingSafeEqual(Buffer.from(fp.replaceAll(":",""),"hex"),pin);
  }catch{return false;}
 }
 const relay={
  async dispatch(connection,envelope){
   if(!authentic(connection))deny();
   const request=validateDshPlatformEnvelope(envelope);
   const action=actionForDshPlatformOperation(request.args.operation);
   const authorize=scope=>{
    if(!authentic(connection)||!permitted.has(action)||scope.operation!==action||
       (request.args.workspaceId!==undefined&&scope.workspaceId!==request.args.workspaceId)||
       (request.args.leadSessionId!==undefined&&scope.leadSessionId!==request.args.leadSessionId))deny();
   };
   if(!permitted.has(action))deny();
   const admin=createOfficialDshPlatformAdmin({...services,workspaceParent,
    authorizeRead:async scope=>authorize(scope),
    withAuthorizedWrite:async(scope,work)=>{
     authorize(scope);const result=await work();authorize(scope);return result;
    }});
   const dispatcher=createDshPlatformPrivateRelay({admin,authenticatePeer:authentic,
    withDurableReplay:(request,commit)=>replay.withDurableReplay(request,commit)});
   return dispatcher.dispatch(connection,request);
  },
 };
 const handle=createDshPlatformPrivateHttpHandler({relay,
  connectionForRequest:req=>authentic(req.socket)?req.socket:undefined});
 const dispose=()=>{active=false;};
 // Preserve the single replay owner for this process, including after disposal:
 // a same-process replacement cannot race an already admitted durable write.
 ctx.effect(()=>dispose);
 return Object.freeze({handle,dispose,
  readiness:Object.freeze({officialServices:true,directoryBrowse:true})});
}

/** Read-only readiness report: no business calls, files, listeners or grants. */
export function inspectDshPlatformExistingHostServices(ctx){
 const required={
  workspaceRegistry:["list","get","resolveByPath"],
  workspaceController:["create","rename"],
  directoryPickerController:["createDirectory"],
  sessionController:["create","resolveAgent"],
  agentTeams:["spawnTeammate","createTask","updateTask"],
  directoryPicker:["capability"],
 };
 const services={};
 for(const [name,methods] of Object.entries(required)){
  try{services[name]=methods.every(method=>typeof ctx?.[name]?.[method]==="function");}
  catch{services[name]=false;}
 }
 let directoryBrowse=false;
 try{directoryBrowse=services.directoryPicker&&ctx.directoryPicker.capability()?.kind==="browse";}
 catch{}
 return Object.freeze({ready:Object.values(services).every(Boolean)&&directoryBrowse,
  directoryBrowse,services:Object.freeze(services)});
}
