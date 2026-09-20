import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "../ssh/pool.js";
import { denySecretPath } from "../security/paths.js";
import { callExecBroker } from "./exec-broker-client.js";

export interface AgentOperation {
  op: string;
  args?: Record<string, string | number | boolean>;
}

function safePath(value: unknown): string {
  const s = String(value ?? "");
  if (!s.startsWith("/") || s.includes("\0") || /[\r\n]/.test(s) || s.split("/").includes("..") || s.length > 1024) throw new Error("invalid_path");
  if (denySecretPath(s)) throw new Error("secret_path_denied");
  return s;
}
function safeId(value: unknown): string {
  const s=String(value??"");
  if(!/^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,99}$/.test(s)) throw new Error("invalid_identifier");
  return s;
}
function safeLines(value: unknown,max=500): number {
  const n=Number(value); if(!Number.isInteger(n)||n<1||n>max) throw new Error("invalid_lines"); return n;
}
function safeBytes(value: unknown,max=1048576): number {
  const n=Number(value); if(!Number.isInteger(n)||n<1||n>max) throw new Error("invalid_bytes"); return n;
}

export function argvToAgentOperation(argv: string[]): AgentOperation {
  const [cmd,...a]=argv;
  if(cmd==="hostname"&&a.length===0)return{op:"host.hostname"};
  if(cmd==="uname"&&a.join(" ")==="-srm")return{op:"host.uname"};
  if(cmd==="cat"&&a.length===1&&a[0]==="/proc/loadavg")return{op:"host.loadavg"};
  if(cmd==="uptime"&&a.length===1&&a[0]==="-p")return{op:"host.uptime_pretty"};
  if(cmd==="uptime"&&a.length===1&&a[0]==="-s")return{op:"host.uptime_since"};
  if(cmd==="head"&&a.length===3&&a[0]==="-n"&&a[1]==="5"&&a[2]==="/etc/os-release")return{op:"host.os_release"};
  if(cmd==="df"&&a.join(" ")==="-hP")return{op:"host.disk_usage"};
  if(cmd==="free"&&a.join(" ")==="-b")return{op:"host.memory"};
  if(cmd==="docker"&&a.join(" ")==='ps -a --format {{json .}}')return{op:"docker.list"};
  if(cmd==="docker"&&a.join(" ")==="ps -q")return{op:"docker.running"};
  if(cmd==="docker"&&a[0]==="inspect"&&a[1]==="--format"&&a[2]==="{{json .State}}"&&a.length===4)return{op:"docker.health",args:{container:safeId(a[3])}};
  if(cmd==="docker"&&a[0]==="inspect"&&a.length===2)return{op:"docker.inspect",args:{container:safeId(a[1])}};
  if(cmd==="docker"&&a[0]==="logs"&&a[1]==="--tail"&&a[3]==="--timestamps"&&a.length===5)return{op:"docker.logs",args:{container:safeId(a[4]),lines:safeLines(a[2])}};
  if(cmd==="systemctl"&&a[0]==="show"&&a.length>=2)return{op:"service.status",args:{unit:safeId(a[1])}};
  if(cmd==="journalctl"&&a[0]==="-u"&&a[2]==="-n")return{op:"service.logs",args:{unit:safeId(a[1]),lines:safeLines(a[3])}};
  if(cmd==="git"&&a[0]==="-C"&&a[2]==="rev-parse"&&a[3]==="HEAD")return{op:"git.head",args:{repo:safePath(a[1])}};
  if(cmd==="git"&&a[0]==="-C"&&a[2]==="log")return{op:"git.log",args:{repo:safePath(a[1])}};
  if(cmd==="git"&&a[0]==="-C"&&a.includes("status"))return{op:"git.status",args:{repo:safePath(a[1])}};
  if(cmd==="git"&&a[0]==="-C"&&a[2]==="diff"&&a.includes("--cached"))return{op:"git.diff_staged",args:{repo:safePath(a[1])}};
  if(cmd==="git"&&a[0]==="-C"&&a[2]==="diff")return{op:"git.diff",args:{repo:safePath(a[1])}};
  if(cmd==="realpath"&&a[0]==="-e"&&a[1]==="--"&&a.length===3)return{op:"fs.realpath",args:{path:safePath(a[2])}};
  if(cmd==="ls"&&a[0]==="-la"&&a[1]==="--time-style=long-iso"&&a.length===3)return{op:"fs.list",args:{path:safePath(a[2])}};
  if(cmd==="stat"&&a[0]==="-c"&&a[1]==="%s"&&a.length===3)return{op:"fs.stat_size",args:{path:safePath(a[2])}};
  if(cmd==="head"&&a[0]==="-c"&&a.length===3)return{op:"fs.read_head",args:{bytes:safeBytes(a[1]),path:safePath(a[2])}};
  throw new Error("unsupported_agent_operation");
}

function operationArgv(x: AgentOperation): string[] {
  const a=x.args??{};
  switch(x.op){
    case "host.hostname": return ["hostname"];
    case "host.uname": return ["uname","-srm"];
    case "host.loadavg": return ["cat","/proc/loadavg"];
    case "host.uptime_pretty": return ["uptime","-p"];
    case "host.uptime_since": return ["uptime","-s"];
    case "host.os_release": return ["head","-n","5","/etc/os-release"];
    case "host.disk_usage": return ["df","-hP"];
    case "host.memory": return ["free","-b"];
    case "docker.list": return ["docker","ps","-a","--format","{{json .}}"];
    case "docker.running": return ["docker","ps","-q"];
    case "docker.health": return ["docker","inspect","--format","{{json .State}}",safeId(a.container)];
    case "docker.inspect": return ["docker","inspect",safeId(a.container)];
    case "docker.logs": return ["docker","logs","--tail",String(safeLines(a.lines)),"--timestamps",safeId(a.container)];
    case "service.status": return ["systemctl","show",safeId(a.unit),"-p","LoadState","-p","ActiveState","-p","SubState","-p","UnitFileState","-p","ExecMainPID","-p","MemoryCurrent","-p","NRestarts","-p","FragmentPath","--no-pager"];
    case "service.logs": return ["journalctl","-u",safeId(a.unit),"-n",String(safeLines(a.lines)),"--no-pager","-o","short-iso"];
    case "git.head": return ["git","-C",safePath(a.repo),"rev-parse","HEAD"];
    case "git.log": return ["git","-C",safePath(a.repo),"log","-1","--format=%H%n%an%n%aI%n%s"];
    case "git.status": return ["git","-C",safePath(a.repo),"-c","core.quotepath=false","status","--porcelain=v1","-b"];
    case "git.diff": return ["git","-C",safePath(a.repo),"diff","--stat"];
    case "git.diff_staged": return ["git","-C",safePath(a.repo),"diff","--cached","--stat"];
    case "fs.realpath": return ["realpath","-e","--",safePath(a.path)];
    case "fs.list": return ["ls","-la","--time-style=long-iso",safePath(a.path)];
    case "fs.stat_size": return ["stat","-c","%s",safePath(a.path)];
    case "fs.read_head": return ["head","-c",String(safeBytes(a.bytes)),safePath(a.path)];
    default: throw new Error("unsupported_agent_operation");
  }
}

function childEnvForOperation(x: AgentOperation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
  if (x.op.startsWith("docker.")) {
    const dockerHost = process.env.DOCKER_HOST;
    if (dockerHost !== "tcp://127.0.0.1:23751") throw new Error("docker_read_proxy_required");
    env.DOCKER_HOST = dockerHost;
  }
  return env;
}

export async function executeAgentOperation(x: AgentOperation, opts?: ExecOptions): Promise<ExecResult> {
  if (x.op.startsWith("workspace.") || x.op.startsWith("process.")) {
    const started = Date.now();
    try {
      const response = await callExecBroker({ op: x.op, args: x.args ?? {} }, opts?.timeoutMs ?? 15_000);
      if (!response.ok) {
        return { code: 1, stdout: "", stderr: response.error?.code + ": " + response.error?.message, durationMs: Date.now()-started, truncated: false, timedOut: false };
      }
      return { code: 0, stdout: JSON.stringify(response.result ?? {}), stderr: "", durationMs: Date.now()-started, truncated: false, timedOut: false };
    } catch (e) {
      return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e), durationMs: Date.now()-started, truncated: false, timedOut: false };
    }
  }
  const argv=operationArgv(x), timeoutMs=opts?.timeoutMs??15000, maxBytes=opts?.maxBytes??262144, started=Date.now(), childEnv=childEnvForOperation(x);
  return await new Promise<ExecResult>((resolve,reject)=>{
    const child=spawn(argv[0],argv.slice(1),{stdio:["ignore","pipe","pipe"],shell:false,env:childEnv});
    let out: Buffer<ArrayBufferLike>=Buffer.alloc(0),err: Buffer<ArrayBufferLike>=Buffer.alloc(0),truncated=false,timedOut=false;
    const append=(buf:Buffer<ArrayBufferLike>,chunk:Buffer<ArrayBufferLike>,cap:number):Buffer<ArrayBufferLike>=>{if(buf.length>=cap){truncated=true;return buf;}if(buf.length+chunk.length>cap){truncated=true;return Buffer.concat([buf,chunk.subarray(0,cap-buf.length)]);}return Buffer.concat([buf,chunk]);};
    child.stdout.on("data",(c:Buffer)=>{out=append(out,c,maxBytes);});
    child.stderr.on("data",(c:Buffer)=>{err=append(err,c,Math.min(maxBytes,65536));});
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},timeoutMs);
    child.on("error",reject);
    child.on("close",(code)=>{clearTimeout(timer);resolve({code,stdout:out.toString("utf8"),stderr:err.toString("utf8"),durationMs:Date.now()-started,truncated,timedOut});});
  });
}