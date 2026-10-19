/**
 * Review-only DSH relay entrypoint. There is deliberately no listener unless
 * DSH_UNIX_RELAY_ENABLED=1 and all operator-owned configuration validates.
 * No DNS change, Docker action, OAuth application or mutable MCP input here.
 */
import {readFile as systemReadFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {createDshAgentMeshUnixRelayOverMtls} from "./agent-mesh-unix-relay.mjs";
import {startDshUnixRelayListener} from "./agent-mesh-unix-listener.mjs";

const deny=()=>{throw Error("dsh_unix_relay_startup_denied");};
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PIN=/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;
const CA="/run/secrets/dsh-bridge-ca.pem";
const CERT="/run/secrets/dsh-bridge-client-cert.pem";
const KEY="/run/secrets/dsh-bridge-client-key.pem";

export async function startDshUnixRelayRuntime({
  env=process.env,readFile=systemReadFile,createHandler=createDshAgentMeshUnixRelayOverMtls,
  startListener=startDshUnixRelayListener,
}={}){
  const socketGroupId=Number(env.DSH_UNIX_RELAY_SOCKET_GID);
  if(env.DSH_UNIX_RELAY_ENABLED!=="1"||
     !/^[1-9][0-9]*$/.test(env.DSH_UNIX_RELAY_SOCKET_GID??"")||
     !Number.isSafeInteger(socketGroupId)||
     !ID.test(env.DSH_UNIX_RELAY_WORKSPACE_ID??"")||
     !ID.test(env.DSH_UNIX_RELAY_LEAD_SESSION_ID??"")||
     !PIN.test(env.DSH_BRIDGE_SERVER_FP_SHA256??""))deny();
  let tls;
  try{
    const [ca,cert,key]=await Promise.all([readFile(CA),readFile(CERT),readFile(KEY)]);
    if(![ca,cert,key].every(v=>Buffer.isBuffer(v)&&v.length>0&&v.length<=32768))deny();
    tls={ca,cert,key};
    const handler=createHandler({
      tls,serverFingerprintSha256:env.DSH_BRIDGE_SERVER_FP_SHA256,
      workspaceId:env.DSH_UNIX_RELAY_WORKSPACE_ID,
      leadSessionId:env.DSH_UNIX_RELAY_LEAD_SESSION_ID,
    });
    return await startListener({enabled:true,handler,socketGroupId});
  }catch{deny();}
}
// Main is never entered from CI imports or the existing Remote-Ops MCP service.
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  startDshUnixRelayRuntime().then(listener=>{
    process.stdout.write("DSH_UNIX_RELAY_LISTENING\n");
    const terminate=()=>{
      listener.close().then(()=>process.exit(0)).catch(()=>process.exit(1));
    };
    process.once("SIGTERM",terminate);
    process.once("SIGINT",terminate);
  }).catch(()=>{
    process.stderr.write("DSH_UNIX_RELAY_NOT_STARTED\n");
    process.exitCode=1;
  });
}
