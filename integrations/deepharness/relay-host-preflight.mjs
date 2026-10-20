/**
 * DSH relay review preflight (read only). No mkdir, useradd, chmod,
 * credential read, Docker creation, Agent Mesh dispatch or network socket.
 * The executable CLI is opt-in: node relay-host-preflight.mjs --dry-run.
 */
import {execFileSync} from "node:child_process";
import {lstatSync} from "node:fs";
import os from "node:os";
import {fileURLToPath} from "node:url";

const NETWORK="deepharness_mcp-private";
const DIRECTORY="/run/wandora/deepharness-semantic";
const SOCKET=DIRECTORY+"/bridge.sock";
const WEB="deepharness-web-1",PROXY="deepharness-mcp-proxy-1";
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const owner=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x)&&Number.isSafeInteger(Number(x));
function safeStat(file){
  try{
    const s=lstatSync(file);
    return {present:true,uid:s.uid,gid:s.gid,mode:s.mode&0o7777,
      directory:s.isDirectory(),socket:s.isSocket(),symlink:s.isSymbolicLink()};
  }catch(error){
    if(error?.code==="ENOENT")return {present:false};
    return {present:null};
  }
}
function run(command,args){
  return execFileSync(command,args,{encoding:"utf8",timeout:5000,maxBuffer:65536}).trim();
}
function inspectContainer(name){
  const parsed=JSON.parse(run("docker",["inspect",name]));
  if(!Array.isArray(parsed)||parsed.length!==1)throw Error("invalid_inspect");
  return parsed[0];
}
function inspectNetwork(){
  const parsed=JSON.parse(run("docker",["network","inspect",NETWORK]));
  if(!Array.isArray(parsed)||parsed.length!==1)throw Error("invalid_network");
  return parsed[0];
}
export function evaluateDshRelayHostPreflight(o={}){
  const checks=[],record=(name,ok,detail)=>checks.push({name,ok,detail});
  record("host",o.hostname==="28server","expected exact DSH host identity");
  record("agent",o.agentActive==="active"&&o.agentUser==="ops-mcp"&&
    o.agentGroup==="ops-mcp"&&owner(String(o.agentUid??""))&&
    owner(String(o.agentGid??"")),"active ops-mcp service with numeric host identity");
  record("network",o.network?.Name===NETWORK&&o.network?.Internal===true,
    "existing internal Docker network only");
  const web=o.web,proxy=o.proxy;
  const webAttachment=web?.NetworkSettings?.Networks?.[NETWORK];
  const proxyAttachment=proxy?.NetworkSettings?.Networks?.[NETWORK];
  record("backend",web?.Name==="/"+WEB&&web?.Config?.User==="1000:1000"&&
    Array.isArray(webAttachment?.Aliases)&&
    webAttachment.Aliases.includes("deepharness-mcp-backend"),
    "running backend identity and fixed DNS alias on internal network");
  record("proxy",proxy?.Name==="/"+PROXY&&
    proxy?.Config?.User==="1000:1000"&&!!proxyAttachment,
    "existing MCP proxy attached to internal network");
  const agentUid=Number(o.agentUid),agentGid=Number(o.agentGid);
  record("relay_uid_candidate",owner(String(o.relayUid??""))&&
    Number(o.relayUid)!==agentUid&&Number(o.relayUid)!==1000,
    "relay UID must be selected separately, nonroot and distinct from ops-mcp and web");
  record("agent_group",Number.isSafeInteger(agentGid)&&agentGid>0,
    "existing ops-mcp GID used only for Unix socket group");
  record("socket_directory",o.directory?.present===false||
    (o.directory?.present===true&&!o.directory.symlink&&o.directory.directory&&
     o.directory.uid===Number(o.relayUid)&&o.directory.gid===agentGid&&
     o.directory.mode===0o2710),
    "must be absent or match exact relayUID:opsGID mode 02710");
  record("socket",o.socket?.present===false,
    "pre-installation socket must be absent; no live listener activated");
  const failing=checks.filter(c=>!c.ok).map(c=>c.name);
  return Object.freeze({
    mode:"read_only_review",status:failing.length?"NO_GO":"PREPARE_ONLY",
    // PREPARE_ONLY is deliberately never authorization to create or start anything.
    checked:checks,failures:failing,
    activation_authorized:false,secrets_verified:false,mtls_listener_verified:false,
  });
}
export function readHostObservation(relayUid){
  const unit=run("systemctl",["show","wandora-ops-agent.service",
    "-p","User","-p","Group","-p","ActiveState","--no-pager"]);
  const props=Object.fromEntries(unit.split("\n").filter(x=>x.includes("=")).map(x=>{
    const [k,...v]=x.split("=");return [k,v.join("=")];
  }));
  return {
    hostname:os.hostname(),agentActive:props.ActiveState,
    agentUser:props.User,agentGroup:props.Group,
    agentUid:run("id",["-u","ops-mcp"]),agentGid:run("id",["-g","ops-mcp"]),
    relayUid,network:inspectNetwork(),
    web:inspectContainer(WEB),proxy:inspectContainer(PROXY),
    directory:safeStat(DIRECTORY),socket:safeStat(SOCKET),
  };
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(!process.argv.includes("--dry-run")||process.argv.some(x=>x.startsWith("--")&&x!=="--dry-run"&&!x.startsWith("--relay-uid="))){
    process.stderr.write("Usage: node relay-host-preflight.mjs --dry-run [--relay-uid=NUMERIC_UID]\n");
    process.exitCode=2;
  }else{
    const uidFlag=process.argv.find(x=>x.startsWith("--relay-uid="));
    try{
      const result=evaluateDshRelayHostPreflight(readHostObservation(uidFlag?.split("=")[1]));
      process.stdout.write(JSON.stringify(result,null,2)+"\n");
      process.exitCode=result.status==="PREPARE_ONLY"?0:1;
    }catch{
      process.stderr.write("DSH_RELAY_PREFLIGHT=NO_GO (read-only inspection unavailable)\n");
      process.exitCode=1;
    }
  }
}
