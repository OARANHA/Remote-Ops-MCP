import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"remote-ops-exec-"));
const root=path.join(tmp,"workspace"), socket=path.join(tmp,"exec.sock");
fs.mkdirSync(root,{recursive:true});
const child=spawn(process.execPath,["dist/exec/broker.js"],{env:{...process.env,WANDORA_EXEC_BROKER_SOCKET:socket,WANDORA_EXEC_ROOTS:root,WANDORA_EXEC_PROGRAMS:"bash"},stdio:["ignore","pipe","pipe"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<50&&!fs.existsSync(socket);i++) await sleep(40);
if(!fs.existsSync(socket)) throw new Error("broker socket not created");

const call=(op,args={})=>new Promise((resolve,reject)=>{
 const s=net.createConnection({path:socket}); let data="";
 s.setEncoding("utf8"); s.on("connect",()=>s.write(JSON.stringify({op,args})+"\n"));
 s.on("data",(c)=>{data+=c;const n=data.indexOf("\n");if(n>=0){try{resolve(JSON.parse(data.slice(0,n)));}catch(e){reject(e);}s.destroy();}});
 s.on("error",reject);
});
const ok=async(op,args={})=>{const r=await call(op,args);if(!r.ok)throw new Error(op+":"+JSON.stringify(r));return r.result;};

await ok("workspace.mkdir",{path:path.join(root,"a")});
await ok("workspace.write",{path:path.join(root,"a","x.txt"),content_b64:Buffer.from("hello world").toString("base64"),mode:"rewrite"});
await ok("workspace.edit",{path:path.join(root,"a","x.txt"),old_b64:Buffer.from("world").toString("base64"),new_b64:Buffer.from("broker").toString("base64"),expected_replacements:1});
await ok("workspace.move",{source:path.join(root,"a","x.txt"),destination:path.join(root,"a","y.txt")});
if(fs.readFileSync(path.join(root,"a","y.txt"),"utf8")!=="hello broker") throw new Error("file operations mismatch");
console.log("EXEC_WORKSPACE_FILES=PASS");

const started=await ok("process.start",{cwd:root,program:"bash",argv:["-c","read x; echo got:$x"]});
await ok("process.input",{session_id:started.session_id,input_b64:Buffer.from("hello\n").toString("base64")});
await sleep(150);
const out=await ok("process.read",{session_id:started.session_id,offset:0,max_chars:65536});
if(!String(out.output).includes("got:hello")||out.running) throw new Error("interactive process failed");
console.log("EXEC_PROCESS_SESSION=PASS");

const long=await ok("process.start",{cwd:root,program:"bash",argv:["-c","sleep 30"]});
await ok("process.kill",{session_id:long.session_id,signal:"SIGTERM"});
console.log("EXEC_PROCESS_KILL=PASS");

const denied=await call("workspace.write",{path:path.join(root,".env"),content_b64:Buffer.from("x").toString("base64")});
if(denied.ok) throw new Error("secret path unexpectedly allowed");
console.log("EXEC_SECRET_PATH_DENIED=PASS");

child.kill("SIGTERM");
fs.rmSync(tmp,{recursive:true,force:true});
console.log("EXECUTION_MVP_BROKER=GREEN");
