#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Json = Record<string, unknown>;
interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  cwd: string;
  program: string;
  output: string;
  exitCode: number | null;
  closedAt?: number;
}

const SOCKET = process.env.WANDORA_EXEC_BROKER_SOCKET ?? "/run/wandora-ops-exec/exec.sock";
const ROOTS = (process.env.WANDORA_EXEC_ROOTS ?? "/opt/wandora/ops-workspace").split(",").map((x) => x.trim()).filter(Boolean);
const PROGRAMS = new Set((process.env.WANDORA_EXEC_PROGRAMS ?? "bash,sh,git,node,npm,npx,pnpm,python3,curl,wget,jq,grep,sed,awk,find,head,tail,cat,wc,make").split(",").map((x) => x.trim()).filter(Boolean));
const MAX_SESSIONS = 16;
const MAX_OUTPUT = 1024 * 1024;
const MAX_WRITE = 512 * 1024;
const sessions = new Map<string, Session>();

function reply(socket: net.Socket, body: Json): void { socket.end(JSON.stringify(body) + "\n"); }
function fail(socket: net.Socket, code: string, message: string): void { reply(socket, { ok: false, error: { code, message } }); }
function isSecretPath(p: string): boolean {
  return /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)|(^|\/)(\.env(?:\.[^/]*)?|authorized_keys|known_hosts|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.htpasswd|shadow|gshadow)(\/|$)|\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(p);
}
function cleanAbs(input: unknown): string {
  const s = String(input ?? "");
  if (!s.startsWith("/") || s.includes("\0") || /[\r\n]/.test(s) || s.split("/").includes("..") || s.length > 2048) throw new Error("invalid_path");
  const normalized = path.posix.normalize(s);
  if (isSecretPath(normalized)) throw new Error("secret_path_denied");
  return normalized;
}
function rootReal(root: string): string { return fs.realpathSync(root).replace(/\/+$/, ""); }
function inside(root: string, p: string): boolean { return p === root || p.startsWith(root + "/"); }
function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try { fs.lstatSync(cur); return cur; } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) throw new Error("path_parent_missing");
    cur = parent;
  }
}
function checkedPath(input: unknown, requireExisting: boolean): string {
  const normalized = cleanAbs(input);
  const allowedRoots = ROOTS.map(rootReal);
  if (requireExisting) {
    const real = fs.realpathSync(normalized);
    if (!allowedRoots.some((r) => inside(r, real))) throw new Error("path_outside_workspace");
    if (isSecretPath(real)) throw new Error("secret_path_denied");
    return real;
  }
  const existing = fs.realpathSync(nearestExisting(normalized));
  const root = allowedRoots.find((r) => inside(r, existing));
  if (!root) throw new Error("path_outside_workspace");
  const rel = path.relative(existing, normalized);
  const candidate = path.join(existing, rel);
  if (!inside(root, candidate)) throw new Error("path_outside_workspace");
  return candidate;
}
function textArg(v: unknown, max: number): string {
  const s = String(v ?? "");
  if (Buffer.byteLength(s, "utf8") > max) throw new Error("argument_too_large");
  return s;
}
function decodeB64(v: unknown, max = MAX_WRITE): Buffer {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("invalid_base64");
  const b = Buffer.from(s, "base64");
  if (b.length > max) throw new Error("payload_too_large");
  return b;
}
function safeProgram(v: unknown): string {
  const p = String(v ?? "");
  if (!/^[A-Za-z0-9_.+-]{1,80}$/.test(p) || !PROGRAMS.has(p)) throw new Error("program_not_allowed");
  return p;
}
function safeArgs(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 80) throw new Error("invalid_args");
  return v.map((x) => textArg(x, 16_384));
}
function append(s: Session, label: string, chunk: Buffer): void {
  const add = label + chunk.toString("utf8");
  s.output += add;
  if (Buffer.byteLength(s.output, "utf8") > MAX_OUTPUT) s.output = s.output.slice(-MAX_OUTPUT);
}
function reap(): void {
  const now = Date.now();
  for (const [id,s] of sessions) if (s.closedAt && now - s.closedAt > 30 * 60_000) sessions.delete(id);
}
async function handle(req: Json): Promise<Json> {
  reap();
  const op = String(req.op ?? "");
  const a = (req.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {}) as Json;
  if (op === "workspace.mkdir") {
    const target = checkedPath(a.path, false); fs.mkdirSync(target, { recursive: true, mode: 0o750 }); return { path: target };
  }
  if (op === "workspace.write") {
    const target = checkedPath(a.path, false), mode = a.mode === "append" ? "append" : "rewrite", data = decodeB64(a.content_b64);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    if (mode === "append") fs.appendFileSync(target, data, { mode: 0o640 }); else { const tmp = target + ".tmp-" + process.pid; fs.writeFileSync(tmp, data, { mode: 0o640 }); fs.renameSync(tmp, target); }
    return { path: target, bytes: data.length, mode };
  }
  if (op === "workspace.edit") {
    const target = checkedPath(a.path, true), oldText = decodeB64(a.old_b64).toString("utf8"), newText = decodeB64(a.new_b64).toString("utf8"), expected = Number(a.expected_replacements ?? 1);
    if (!Number.isInteger(expected) || expected < 1 || expected > 100) throw new Error("invalid_expected_replacements");
    const current = fs.readFileSync(target, "utf8"), count = current.split(oldText).length - 1;
    if (count !== expected) throw new Error("replacement_count_mismatch:" + count);
    const updated = current.split(oldText).join(newText), tmp = target + ".tmp-" + process.pid; fs.writeFileSync(tmp, updated, { mode: fs.statSync(target).mode & 0o777 }); fs.renameSync(tmp, target);
    return { path: target, replacements: count };
  }
  if (op === "workspace.move") {
    const source = checkedPath(a.source, true), destination = checkedPath(a.destination, false); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o750 }); fs.renameSync(source, destination); return { source, destination };
  }
  if (op === "process.start") {
    if (sessions.size >= MAX_SESSIONS) throw new Error("session_capacity");
    const cwd = checkedPath(a.cwd, true), program = safeProgram(a.program), args = safeArgs(a.argv);
    const child = spawn(program, args, { cwd, shell: false, stdio: ["pipe","pipe","pipe"], env: { PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: process.env.HOME ?? "/var/lib/wandora-exec", LANG: "C.UTF-8", TERM: "dumb" } });
    const id = "ps_" + crypto.randomBytes(12).toString("hex"), s: Session = { id, child, startedAt: Date.now(), cwd, program, output: "", exitCode: null };
    sessions.set(id,s); child.stdout.on("data",(c:Buffer)=>append(s,"",c)); child.stderr.on("data",(c:Buffer)=>append(s,"[stderr] ",c)); child.on("close",(code)=>{s.exitCode=code;s.closedAt=Date.now();}); child.on("error",(e)=>append(s,"[error] ",Buffer.from(e.message+"\n")));
    return { session_id:id, pid:child.pid ?? null, cwd, program };
  }
  if (op === "process.read") {
    const id = String(a.session_id ?? ""), s=sessions.get(id); if(!s) throw new Error("session_not_found");
    const offset=Math.max(0,Number(a.offset??0)||0), limit=Math.min(Math.max(Number(a.max_chars??65536)||65536,1),262144), out=s.output.slice(offset,offset+limit);
    return { session_id:id, running:s.exitCode===null, exit_code:s.exitCode, output:out, next_offset:offset+out.length, truncated:offset+out.length<s.output.length };
  }
  if (op === "process.input") {
    const id=String(a.session_id??""), s=sessions.get(id); if(!s||s.exitCode!==null) throw new Error("session_not_running"); const data=decodeB64(a.input_b64,65536); s.child.stdin.write(data); return { session_id:id, bytes:data.length };
  }
  if (op === "process.kill") {
    const id=String(a.session_id??""), s=sessions.get(id); if(!s) throw new Error("session_not_found"); const signal=String(a.signal??"SIGTERM"); if(!["SIGTERM","SIGINT","SIGKILL"].includes(signal)) throw new Error("signal_not_allowed"); const sent=s.child.kill(signal as NodeJS.Signals); return { session_id:id, signal, sent };
  }
  if (op === "process.list") {
    return { sessions:[...sessions.values()].map((s)=>({session_id:s.id,pid:s.child.pid??null,program:s.program,cwd:s.cwd,running:s.exitCode===null,exit_code:s.exitCode,started_at:new Date(s.startedAt).toISOString()})) };
  }
  throw new Error("unsupported_operation");
}

fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o750 });
try { fs.unlinkSync(SOCKET); } catch {}
const server = net.createServer((socket) => {
  socket.setEncoding("utf8"); let data="";
  socket.on("data",(chunk)=>{ data += chunk; if(data.length>1024*1024){fail(socket,"REQUEST_TOO_LARGE","request too large");return;} const nl=data.indexOf("\n"); if(nl<0)return; let req:Json; try{req=JSON.parse(data.slice(0,nl)) as Json;}catch{fail(socket,"INVALID_JSON","invalid json");return;} void handle(req).then((result)=>reply(socket,{ok:true,result})).catch((e)=>fail(socket,"BROKER_DENIED",e instanceof Error?e.message:String(e))); });
});
server.listen(SOCKET, () => { fs.chmodSync(SOCKET,0o660); process.stdout.write("EXEC_BROKER=LISTENING socket="+SOCKET+"\n"); });
