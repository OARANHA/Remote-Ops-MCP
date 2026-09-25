import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import nodePath from "node:path";
import { denySecretPath } from "../security/paths.js";
import { PAPERCLIP_SEMANTIC_CONTAINER, normalizePaperclipSemanticPayload, paperclipSemanticExecCommand, type PaperclipSemanticOperation } from "./paperclip-semantic.js";

const PORT = Number(process.env.PORT ?? 2375);
const SOCKET = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const MAX_BYTES = Math.min(Math.max(Number(process.env.MAX_PROXY_BYTES ?? 2 * 1024 * 1024), 64 * 1024), 8 * 1024 * 1024);
const allowed = csvSet(process.env.ALLOWED_DOCKER_CONTAINERS);
const execContainers = csvSet(process.env.ALLOWED_DOCKER_EXEC_CONTAINERS);
const execPrograms = csvSet(process.env.ALLOWED_DOCKER_EXEC_PROGRAMS);
const allowedActions = csvSet(process.env.ALLOWED_DOCKER_ACTIONS);
const imageLoadRoots = csvSet(process.env.ALLOWED_DOCKER_IMAGE_LOAD_ROOTS);
const candidateImagePrefixes = csvSet(process.env.ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES);
const candidateNetworks = csvSet(process.env.ALLOWED_DOCKER_CANDIDATE_NETWORKS);
const candidateNamePrefixes = csvSet(process.env.ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES);
const candidateHostPorts = csvNumberSet(process.env.ALLOWED_DOCKER_CANDIDATE_HOST_PORTS);
const candidateContainerPorts = csvNumberSet(process.env.ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("invalid PORT");
if (allowed.size === 0) throw new Error("ALLOWED_DOCKER_CONTAINERS must not be empty");
for (const action of allowedActions) if (!["start","stop","restart"].includes(action)) throw new Error("invalid ALLOWED_DOCKER_ACTIONS");

function csvSet(raw = ""): Set<string> { return new Set(raw.split(",").map((x) => x.trim()).filter(Boolean)); }
function csvNumberSet(raw = ""): Set<number> {
  const out=new Set<number>();
  for(const item of raw.split(",").map((x)=>x.trim()).filter(Boolean)){
    const n=Number(item); if(!Number.isInteger(n)||n<1||n>65535) throw new Error("invalid numeric Docker allowlist");
    out.add(n);
  }
  return out;
}
function allowedPrefix(set:Set<string>,value:string):boolean{return [...set].some((prefix)=>prefix==="*"||value.startsWith(prefix));}
function cleanImageRef(value:unknown):string|null{
  const s=String(value??""); return /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/.test(s)?s:null;
}
function cleanPort(value:unknown):number|null{
  const n=Number(value); return Number.isInteger(n)&&n>=1&&n<=65535?n:null;
}
function cleanAllowedLoadPath(value:unknown):string|null{
  const raw=String(value??"");
  if(!raw.startsWith("/")||raw.includes("\0")||/[\r\n]/.test(raw)||raw.split("/").includes("..")||denySecretPath(raw)||!raw.endsWith(".tar")) return null;
  let real:string;
  try{real=fs.realpathSync(raw);}catch{return null;}
  if(denySecretPath(real)||!real.endsWith(".tar"))return null;
  for(const rootRaw of imageLoadRoots){
    let root:string; try{root=fs.realpathSync(rootRaw).replace(/\/+$/,"");}catch{continue;}
    if(real===root||real.startsWith(root+"/"))return real;
  }
  return null;
}
function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": typeof body === "string" ? Buffer.byteLength(body) : body.length });
  res.end(body);
}
function jsonError(res: ServerResponse, status: number, code: string): void { send(res, status, JSON.stringify({ error: code })); }
function stripApiVersion(pathname: string): string { return pathname.replace(/^\/v\d+(?:\.\d+)?/, "") || "/"; }
function cleanContainerRef(ref: string): string | null {
  try { ref = decodeURIComponent(ref); } catch { return null; }
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref) ? ref : null;
}
function cleanProgram(value: unknown): string | null {
  const p=String(value??"");
  return /^[A-Za-z0-9_.+-]{1,80}$/.test(p) ? p : null;
}
function cleanArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 80) return null;
  const out:string[]=[];
  for (const item of value) {
    const s=String(item??"");
    if (Buffer.byteLength(s,"utf8") > 16384 || /[\0\r\n]/.test(s)) return null;
    out.push(s);
  }
  return out;
}
async function readBody(req: IncomingMessage, max=128*1024): Promise<Buffer> {
  const chunks:Buffer[]=[]; let total=0;
  for await (const chunk of req) {
    const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    total+=b.length; if(total>max) throw new Error("request_too_large"); chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function dockerRequest(method: string, reqPath: string, body?: Buffer, contentType = "application/json"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers:Record<string,string|number>={host:"docker"};
    if(body){headers["content-type"]=contentType;headers["content-length"]=body.length;}
    const r = http.request({ socketPath: SOCKET, path: reqPath, method, headers }, (u) => {
      const chunks: Buffer[] = []; let total = 0;
      u.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) { r.destroy(new Error("upstream_response_too_large")); return; }
        chunks.push(chunk);
      });
      u.on("end", () => resolve({ status: u.statusCode ?? 502, headers: u.headers, body: Buffer.concat(chunks) }));
    });
    r.setTimeout(30000, () => r.destroy(new Error("upstream_timeout")));
    r.on("error", reject);
    if(body) r.write(body);
    r.end();
  });
}
function dockerFileRequest(reqPath:string,filePath:string):Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer}>{
  return new Promise((resolve,reject)=>{
    let stat:fs.Stats; try{stat=fs.statSync(filePath);}catch(e){reject(e);return;}
    if(!stat.isFile()){reject(new Error("image_load_path_not_file"));return;}
    const headers:Record<string,string|number>={host:"docker","content-type":"application/x-tar","content-length":stat.size};
    const r=http.request({socketPath:SOCKET,path:reqPath,method:"POST",headers},(u)=>{
      const chunks:Buffer[]=[];let total=0;
      u.on("data",(chunk:Buffer)=>{total+=chunk.length;if(total>MAX_BYTES){r.destroy(new Error("upstream_response_too_large"));return;}chunks.push(chunk);});
      u.on("end",()=>resolve({status:u.statusCode??502,headers:u.headers,body:Buffer.concat(chunks)}));
    });
    r.setTimeout(120000,()=>r.destroy(new Error("upstream_timeout")));
    r.on("error",reject);
    const stream=fs.createReadStream(filePath); stream.on("error",(e)=>r.destroy(e)); stream.pipe(r);
  });
}
async function resolveAllowedContainerRef(rawRef: string, scope: Set<string> = allowed): Promise<string | null> {
  const ref = cleanContainerRef(rawRef);
  if (!ref) return null;
  if (scope.has(ref)) return ref;
  if (!/^[a-f0-9]{12,64}$/i.test(ref)) return null;
  const u = await dockerRequest("GET","/containers/json?all=1");
  if (u.status !== 200) return null;
  let items: unknown;
  try { items = JSON.parse(u.body.toString("utf8")); } catch { return null; }
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const c = item as { Id?: unknown; Names?: unknown };
    const id = typeof c.Id === "string" ? c.Id : "";
    const names = Array.isArray(c.Names) ? c.Names : [];
    if ((id === ref || id.startsWith(ref)) && names.some((n) => typeof n === "string" && scope.has(n.replace(/^\//, "")))) return ref;
  }
  return null;
}
function allowedQuery(url: URL, keys: Set<string>): boolean {
  for (const key of url.searchParams.keys()) if (!keys.has(key)) return false;
  return true;
}
function demuxDockerStream(body:Buffer):{stdout:string;stderr:string;truncated:boolean}{
  let i=0, stdout="", stderr="", frames=0;
  while(i+8<=body.length){
    const stream=body[i], len=body.readUInt32BE(i+4);
    if(len<0||i+8+len>body.length) break;
    const text=body.subarray(i+8,i+8+len).toString("utf8");
    if(stream===2) stderr+=text; else stdout+=text;
    i+=8+len; frames++;
  }
  if(frames===0) stdout=body.toString("utf8");
  return {stdout,stderr,truncated:false};
}
async function handlePaperclipSemantic(req:IncomingMessage,res:ServerResponse,path:string):Promise<boolean>{
  const m=/^\/ops\/paperclip\/(task-drain-status|task-drain-start|task-drain-stop|tool-policies-list|tool-connection-activity-safe|tool-policy-test|tool-policy-create|tool-policy-delete)$/.exec(path);
  if(!m) return false;
  if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
  if(!allowed.has(PAPERCLIP_SEMANTIC_CONTAINER)||!execContainers.has(PAPERCLIP_SEMANTIC_CONTAINER)){
    jsonError(res,403,"paperclip_semantic_container_not_allowed");return true;
  }
  let raw:Record<string,unknown>={};
  try{raw=JSON.parse((await readBody(req)).toString("utf8")||"{}") as Record<string,unknown>;}catch{jsonError(res,400,"invalid_json");return true;}
  const op=m[1] as PaperclipSemanticOperation;
  let payload:Record<string,unknown>;
  try{payload=normalizePaperclipSemanticPayload(op,raw);}catch(e){
    const code=e instanceof Error?e.message:"invalid_payload"; jsonError(res,400,code); return true;
  }
  const cmd=paperclipSemanticExecCommand(op,payload);
  const createBody=Buffer.from(JSON.stringify({AttachStdout:true,AttachStderr:true,AttachStdin:false,Tty:false,Cmd:cmd}));
  const created=await dockerRequest("POST","/containers/"+encodeURIComponent(PAPERCLIP_SEMANTIC_CONTAINER)+"/exec",createBody);
  if(created.status!==201){send(res,created.status,created.body);return true;}
  let execId="";
  try{execId=String((JSON.parse(created.body.toString("utf8")) as {Id?:unknown}).Id??"");}catch{}
  if(!/^[a-f0-9]{12,64}$/i.test(execId)){jsonError(res,502,"invalid_exec_id");return true;}
  const started=await dockerRequest("POST","/exec/"+execId+"/start",Buffer.from(JSON.stringify({Detach:false,Tty:false})));
  if(started.status!==200){send(res,started.status,started.body,String(started.headers["content-type"]??"application/json"));return true;}
  const inspected=await dockerRequest("GET","/exec/"+execId+"/json");
  let code=1;
  if(inspected.status===200){try{const x=JSON.parse(inspected.body.toString("utf8")) as {ExitCode?:unknown}; if(typeof x.ExitCode==="number")code=x.ExitCode;}catch{}}
  const out=demuxDockerStream(started.body);
  send(res,200,JSON.stringify({code,...out}));
  return true;
}
async function handleOperator(req:IncomingMessage,res:ServerResponse,path:string):Promise<boolean>{
  if(path==="/ops/images/load"){
    if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
    let payload:Record<string,unknown>; try{payload=JSON.parse((await readBody(req)).toString("utf8")||"{}") as Record<string,unknown>;}catch{jsonError(res,400,"invalid_json");return true;}
    const filePath=cleanAllowedLoadPath(payload.path);
    if(!filePath||imageLoadRoots.size===0){jsonError(res,403,"image_load_path_not_allowed");return true;}
    const u=await dockerFileRequest("/images/load?quiet=1",filePath);
    if(u.status!==200)return send(res,u.status,u.body,String(u.headers["content-type"]??"application/json")),true;
    send(res,200,JSON.stringify({status:"ok",path:nodePath.basename(filePath),docker_output:u.body.toString("utf8").slice(0,MAX_BYTES)}));
    return true;
  }
  if(path==="/ops/candidates/run"){
    if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
    let payload:Record<string,unknown>; try{payload=JSON.parse((await readBody(req)).toString("utf8")||"{}") as Record<string,unknown>;}catch{jsonError(res,400,"invalid_json");return true;}
    const name=cleanContainerRef(String(payload.name??"")), image=cleanImageRef(payload.image), network=cleanContainerRef(String(payload.network??"")), hostPort=cleanPort(payload.hostPort), containerPort=cleanPort(payload.containerPort);
    if(!name||!allowedPrefix(candidateNamePrefixes,name)){jsonError(res,403,"candidate_name_not_allowed");return true;}
    if(!image||!allowedPrefix(candidateImagePrefixes,image)){jsonError(res,403,"candidate_image_not_allowed");return true;}
    if(!network||!candidateNetworks.has(network)){jsonError(res,403,"candidate_network_not_allowed");return true;}
    if(hostPort===null||!candidateHostPorts.has(hostPort)){jsonError(res,403,"candidate_host_port_not_allowed");return true;}
    if(containerPort===null||!candidateContainerPorts.has(containerPort)){jsonError(res,403,"candidate_container_port_not_allowed");return true;}
    const portKey=String(containerPort)+"/tcp";
    const createBody=Buffer.from(JSON.stringify({
      Image:image,
      ExposedPorts:{[portKey]:{}},
      HostConfig:{
        NetworkMode:network,
        PortBindings:{[portKey]:[{HostIp:"127.0.0.1",HostPort:String(hostPort)}]},
        RestartPolicy:{Name:"no",MaximumRetryCount:0},
        Privileged:false,
        ReadonlyRootfs:false,
      },
    }));
    const created=await dockerRequest("POST","/containers/create?name="+encodeURIComponent(name),createBody);
    if(created.status!==201)return send(res,created.status,created.body),true;
    let id=""; try{id=String((JSON.parse(created.body.toString("utf8")) as {Id?:unknown}).Id??"");}catch{}
    if(!/^[a-f0-9]{12,64}$/i.test(id)){jsonError(res,502,"invalid_container_id");return true;}
    const started=await dockerRequest("POST","/containers/"+id+"/start",Buffer.alloc(0));
    if(started.status!==204){await dockerRequest("DELETE","/containers/"+id+"?force=1&v=1").catch(()=>null);return send(res,started.status,started.body),true;}
    send(res,200,JSON.stringify({status:"started",id,name,image,network,hostIp:"127.0.0.1",hostPort,containerPort}));
    return true;
  }
  const candidateRemove=/^\/ops\/candidates\/([^/]+)\/remove$/.exec(path);
  if(candidateRemove){
    if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
    const name=cleanContainerRef(candidateRemove[1]);
    if(!name||!allowedPrefix(candidateNamePrefixes,name)){jsonError(res,403,"candidate_name_not_allowed");return true;}
    await readBody(req).catch(()=>Buffer.alloc(0));
    const u=await dockerRequest("DELETE","/containers/"+encodeURIComponent(name)+"?force=1&v=1");
    if(u.status===404){send(res,200,JSON.stringify({status:"absent",name,removed:false}));return true;}
    if(u.status!==204)return send(res,u.status,u.body),true;
    send(res,200,JSON.stringify({status:"removed",name,removed:true}));
    return true;
  }
  const execMatch=/^\/ops\/containers\/([^/]+)\/exec$/.exec(path);
  if(execMatch){
    if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
    const ref=await resolveAllowedContainerRef(execMatch[1],execContainers);
    if(!ref||!allowed.has(ref)){jsonError(res,403,"container_exec_not_allowed");return true;}
    let payload:Record<string,unknown>;
    try{payload=JSON.parse((await readBody(req)).toString("utf8")||"{}") as Record<string,unknown>;}catch{jsonError(res,400,"invalid_json");return true;}
    const program=cleanProgram(payload.program), argv=cleanArgs(payload.argv);
    if(!program||!argv){jsonError(res,400,"invalid_exec");return true;}
    if(!execPrograms.has(program)){jsonError(res,403,"program_not_allowed");return true;}
    const createBody=Buffer.from(JSON.stringify({AttachStdout:true,AttachStderr:true,AttachStdin:false,Tty:false,Cmd:[program,...argv]}));
    const created=await dockerRequest("POST","/containers/"+encodeURIComponent(ref)+"/exec",createBody);
    if(created.status!==201)return send(res,created.status,created.body),true;
    let execId="";
    try{execId=String((JSON.parse(created.body.toString("utf8")) as {Id?:unknown}).Id??"");}catch{}
    if(!/^[a-f0-9]{12,64}$/i.test(execId)){jsonError(res,502,"invalid_exec_id");return true;}
    const started=await dockerRequest("POST","/exec/"+execId+"/start",Buffer.from(JSON.stringify({Detach:false,Tty:false})));
    if(started.status!==200)return send(res,started.status,started.body,String(started.headers["content-type"]??"application/json")),true;
    const inspected=await dockerRequest("GET","/exec/"+execId+"/json");
    let code=1;
    if(inspected.status===200){try{const x=JSON.parse(inspected.body.toString("utf8")) as {ExitCode?:unknown}; if(typeof x.ExitCode==="number")code=x.ExitCode;}catch{}}
    const out=demuxDockerStream(started.body);
    send(res,200,JSON.stringify({code,...out}));
    return true;
  }
  const actionMatch=/^\/ops\/containers\/([^/]+)\/(start|stop|restart)$/.exec(path);
  if(actionMatch){
    if(req.method!=="POST"){jsonError(res,405,"method_not_allowed");return true;}
    const action=actionMatch[2];
    if(!allowedActions.has(action)){jsonError(res,403,"docker_action_not_allowed");return true;}
    const ref=await resolveAllowedContainerRef(actionMatch[1],allowed);
    if(!ref){jsonError(res,403,"container_not_allowed");return true;}
    await readBody(req).catch(()=>Buffer.alloc(0));
    const q=action==="stop"||action==="restart"?"?t=15":"";
    const u=await dockerRequest("POST","/containers/"+encodeURIComponent(ref)+"/"+action+q);
    if(![204,304].includes(u.status))return send(res,u.status,u.body),true;
    send(res,200,JSON.stringify({container:ref,action,status:"ok"}));
    return true;
  }
  return false;
}
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = new URL(req.url ?? "/", "http://localhost");
  const path = stripApiVersion(raw.pathname);
  if(await handlePaperclipSemantic(req,res,path)) return;
  if(await handleOperator(req,res,path)) return;
  if (req.method !== "GET") return jsonError(res, 405, "method_not_allowed");
  if (path === "/healthz") return send(res, 200, JSON.stringify({ status: "ok", allowed_containers: allowed.size, exec_containers:execContainers.size, exec_programs:execPrograms.size, docker_actions:[...allowedActions], image_load_roots:imageLoadRoots.size, candidate_image_prefixes:candidateImagePrefixes.size, candidate_networks:[...candidateNetworks], candidate_name_prefixes:[...candidateNamePrefixes], candidate_host_ports:[...candidateHostPorts], candidate_container_ports:[...candidateContainerPorts] }));
  if (path === "/_ping") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await dockerRequest("GET","/_ping");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "text/plain"));
  }
  if (path === "/version") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await dockerRequest("GET","/version");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
  }
  if (path === "/containers/json") {
    if (!allowedQuery(raw, new Set(["all", "limit", "size", "filters"]))) return jsonError(res, 400, "query_not_allowed");
    const q = new URLSearchParams();
    q.set("all", raw.searchParams.get("all") === "1" ? "1" : "0");
    if (raw.searchParams.has("limit")) q.set("limit", String(Math.min(Math.max(Number(raw.searchParams.get("limit")) || 0, 0), 100)));
    if (raw.searchParams.has("size")) q.set("size", raw.searchParams.get("size") === "1" ? "1" : "0");
    const u = await dockerRequest("GET","/containers/json?" + q.toString());
    if (u.status !== 200) return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
    let items: unknown;
    try { items = JSON.parse(u.body.toString("utf8")); } catch { return jsonError(res, 502, "invalid_upstream_json"); }
    if (!Array.isArray(items)) return jsonError(res, 502, "invalid_upstream_shape");
    const filtered = items.filter((item) => {
      const names = (item as { Names?: unknown }).Names;
      return Array.isArray(names) && names.some((n) => typeof n === "string" && allowed.has(n.replace(/^\//, "")));
    });
    return send(res, 200, JSON.stringify(filtered));
  }
  const m = /^\/containers\/([^/]+)\/(json|logs)$/.exec(path);
  if (!m) return jsonError(res, 404, "not_allowed");
  const ref = await resolveAllowedContainerRef(m[1],allowed);
  if (!ref) return jsonError(res, 403, "container_not_allowed");
  if (m[2] === "json") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await dockerRequest("GET","/containers/" + encodeURIComponent(ref) + "/json");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
  }
  if (!allowedQuery(raw, new Set(["stdout", "stderr", "timestamps", "tail", "since", "until"]))) return jsonError(res, 400, "query_not_allowed");
  const q = new URLSearchParams();
  q.set("stdout", raw.searchParams.get("stdout") === "0" ? "0" : "1");
  q.set("stderr", raw.searchParams.get("stderr") === "0" ? "0" : "1");
  q.set("timestamps", raw.searchParams.get("timestamps") === "1" ? "1" : "0");
  q.set("tail", String(Math.min(Math.max(Number(raw.searchParams.get("tail") ?? "100") || 100, 1), 500)));
  for (const k of ["since", "until"]) {
    const v = raw.searchParams.get(k);
    if (v && /^\d+(?:\.\d+)?$/.test(v)) q.set(k, v);
  }
  const u = await dockerRequest("GET","/containers/" + encodeURIComponent(ref) + "/logs?" + q.toString());
  return send(res, u.status, u.body, String(u.headers["content-type"] ?? "application/octet-stream"));
}
const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "docker_proxy_error", error: err instanceof Error ? err.message : String(err) }));
    if (!res.headersSent) jsonError(res, 502, "upstream_error"); else res.end();
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "docker-proxy ready", port: PORT, allowed_containers: [...allowed], exec_containers:[...execContainers], exec_programs:[...execPrograms], actions:[...allowedActions], image_load_roots:[...imageLoadRoots], candidate_image_prefixes:[...candidateImagePrefixes], candidate_networks:[...candidateNetworks], candidate_name_prefixes:[...candidateNamePrefixes], candidate_host_ports:[...candidateHostPorts], candidate_container_ports:[...candidateContainerPorts] }));
});
