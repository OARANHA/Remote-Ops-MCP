/**
 * Draft-only AF_UNIX listener lifecycle for the DSH semantic relay.
 * No top-level execution or environment reads. Importing creates no socket.
 * This is NOT a deployed container or certificate/identity provisioning path.
 */
import {createServer as createHttpServer} from "node:http";
import {lstat,chmod,unlink} from "node:fs/promises";

export const DSH_RELAY_SOCKET="/run/wandora/deepharness-semantic/bridge.sock";
const deny=()=>{throw Error("dsh_unix_listener_unavailable");};
const validSocketPath=x=>typeof x==="string"&&x.startsWith("/")&&
  x.endsWith("/bridge.sock")&&!x.includes("\0")&&!x.includes("//")&&
  !x.split("/").includes("..")&&x.length<256;

/**
 * Requires a pre-provisioned owner-only socket directory (0700) and an
 * exact operator enable bit. Never creates directories or removes a
 * pre-existing socket. A separate approved deployment must arrange that
 * the host Agent Mesh identity can reach this socket.
 */
export async function startDshUnixRelayListener({
  enabled=false,handler,socketPath=DSH_RELAY_SOCKET,
  getUid=()=>process.getuid?.(),getDirInfo=lstat,createServer=createHttpServer,
  chmodSocket=chmod,removeSocket=unlink,
}={}){
  if(enabled!==true||typeof handler!=="function"||!validSocketPath(socketPath))deny();
  const uid=getUid();
  if(!Number.isSafeInteger(uid)||uid<=0)deny();
  const dir=socketPath.slice(0,socketPath.lastIndexOf("/"));
  let directory;
  try{directory=await getDirInfo(dir);}catch{deny();}
  if(!directory.isDirectory()||directory.isSymbolicLink?.()||
     directory.uid!==uid||(directory.mode&0o777)!==0o700)deny();

  // The binding must never replace a pre-existing socket, symlink or file.
  try {await getDirInfo(socketPath);deny();}
  catch(error){if(error?.code!=="ENOENT")deny();}
  const server=createServer(handler);
  server.requestTimeout=10_000;
  server.headersTimeout=5_000;
  server.maxHeadersCount=30;
  server.maxConnections=4;
  server.maxRequestsPerSocket=20;
  let created=false,ownInode;
  try{
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(socketPath,()=>{
        server.removeListener("error",reject);
        resolve();
      });
    });
    created=true;
    const info=await getDirInfo(socketPath);
    if(!info.isSocket()||info.isSymbolicLink?.()||info.uid!==uid)deny();
    ownInode=info.ino;
    await chmodSocket(socketPath,0o600);
    const verified=await getDirInfo(socketPath);
    if(!verified.isSocket()||verified.uid!==uid||verified.ino!==ownInode||
       (verified.mode&0o777)!==0o600)deny();
  }catch{
    await new Promise(resolve=>{if(server.listening)server.close(()=>resolve());else resolve();});
    if(created&&ownInode!==undefined){
      try{const current=await getDirInfo(socketPath);
        if(current.isSocket()&&current.ino===ownInode)await removeSocket(socketPath);
      }catch{}
    }
    deny();
  }
  let closing;
  async function close(){
    if(closing)return closing;
    closing=(async()=>{
      await new Promise(resolve=>server.close(()=>resolve()));
      // Node may unlink automatically; never unlink a replaced path.
      try{const current=await getDirInfo(socketPath);
        if(current.isSocket()&&current.ino===ownInode)await removeSocket(socketPath);
      }catch(error){if(error?.code!=="ENOENT")deny();}
    })();
    return closing;
  }
  return Object.freeze({close,server,socketPath});
}
