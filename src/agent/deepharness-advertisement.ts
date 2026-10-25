/**
 * Local capability advertisement for the optional DeepHarness semantic bridge.
 * Unlike transport authorization, this is read-only state observation.
 * A capability is never advertised unless both operator opt-in and the
 * independently owned Unix socket's strict metadata are present.
 */
import {lstatSync} from "node:fs";
import type {Stats} from "node:fs";
import {dirname} from "node:path";

const SOCKET="/run/wandora/deepharness-semantic/bridge.sock";
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Identity={uid:number;gid:number;groups:number[]};
export function canAdvertiseDshSemantic({
  env=process.env,
  stat=lstatSync,
  identity=()=>({uid:process.getuid?.()??0,gid:process.getgid?.()??0,
    groups:process.getgroups?.()??[]}),
}:{
  env?:NodeJS.ProcessEnv;
  stat?:(path:string)=>Stats;
  identity?:()=>Identity;
}={}):boolean {
  try {
    if(env.DSH_AGENT_MESH_ENABLED!=="1"||
       !ID.test(env.DSH_AGENT_MESH_WORKSPACE_ID??"")||
       !ID.test(env.DSH_AGENT_MESH_LEAD_SESSION_ID??""))return false;
    const uidText=env.DSH_AGENT_MESH_RELAY_UID??"";
    const gidText=env.DSH_AGENT_MESH_SOCKET_GID??"";
    if(!/^[1-9][0-9]*$/.test(uidText)||!/^[1-9][0-9]*$/.test(gidText))return false;
    const relayUid=Number(uidText),socketGid=Number(gidText),local=identity();
    if(!Number.isSafeInteger(relayUid)||!Number.isSafeInteger(socketGid)||
       !Number.isSafeInteger(local.uid)||local.uid===0||relayUid===local.uid||
       ![local.gid,...local.groups].includes(socketGid))return false;
    const folder=stat(dirname(SOCKET)),socket=stat(SOCKET);
    return folder.isDirectory()&&!folder.isSymbolicLink()&&
      folder.uid===relayUid&&folder.gid===socketGid&&
      (folder.mode&0o7777)===0o2710&&
      socket.isSocket()&&!socket.isSymbolicLink()&&
      socket.uid===relayUid&&socket.gid===socketGid&&
      (socket.mode&0o777)===0o660;
  }catch{return false;}
}

const PLATFORM_SOCKET="/run/wandora/deepharness-platform/bridge.sock";
export function canAdvertiseDshPlatform({
  env=process.env,
  stat=lstatSync,
  identity=()=>({uid:process.getuid?.()??0,gid:process.getgid?.()??0,
    groups:process.getgroups?.()??[]}),
}:{
  env?:NodeJS.ProcessEnv;
  stat?:(path:string)=>Stats;
  identity?:()=>Identity;
}={}):boolean {
  try {
    if(env.DSH_PLATFORM_AGENT_ENABLED!=="1")return false;
    const uidText=env.DSH_PLATFORM_RELAY_UID??"";
    const gidText=env.DSH_PLATFORM_SOCKET_GID??"";
    if(!/^[1-9][0-9]*$/.test(uidText)||!/^[1-9][0-9]*$/.test(gidText))return false;
    const relayUid=Number(uidText),socketGid=Number(gidText),local=identity();
    if(!Number.isSafeInteger(relayUid)||!Number.isSafeInteger(socketGid)||
       !Number.isSafeInteger(local.uid)||local.uid===0||relayUid===local.uid||
       ![local.gid,...local.groups].includes(socketGid))return false;
    const folder=stat(dirname(PLATFORM_SOCKET)),socket=stat(PLATFORM_SOCKET);
    return folder.isDirectory()&&!folder.isSymbolicLink()&&
      folder.uid===relayUid&&folder.gid===socketGid&&
      (folder.mode&0o7777)===0o2710&&
      socket.isSocket()&&!socket.isSymbolicLink()&&
      socket.uid===relayUid&&socket.gid===socketGid&&
      (socket.mode&0o777)===0o660;
  }catch{return false;}
}
