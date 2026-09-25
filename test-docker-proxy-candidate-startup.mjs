import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const port=32375;
const env={
  ...process.env,
  PORT:String(port),
  DOCKER_SOCKET_PATH:"/tmp/nonexistent-docker.sock",
  ALLOWED_DOCKER_CONTAINERS:"remote-ops-mcp",
  ALLOWED_DOCKER_ACTIONS:"restart,load_image,candidate_run,candidate_remove",
  ALLOWED_DOCKER_IMAGE_LOAD_ROOTS:"/opt/wandora/ops-workspace",
  ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES:"wandora/web:candidate-",
  ALLOWED_DOCKER_CANDIDATE_NETWORKS:"wandora-core",
  ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES:"wandora-web-candidate-",
  ALLOWED_DOCKER_CANDIDATE_HOST_PORTS:"18090",
  ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS:"8080",
};
const child=spawn(process.execPath,["dist/docker/read-proxy.js"],{env,stdio:["ignore","pipe","pipe"]});
let stderr="", stdout="";
child.stderr.on("data",(c)=>stderr+=c.toString());
child.stdout.on("data",(c)=>stdout+=c.toString());

async function getHealth(){
  return await new Promise((resolve,reject)=>{
    const req=http.get({host:"127.0.0.1",port,path:"/healthz"},(res)=>{
      let data=""; res.on("data",(c)=>data+=c.toString()); res.on("end",()=>resolve({status:res.statusCode,body:data}));
    });
    req.on("error",reject);
  });
}

try{
  let health=null;
  for(let i=0;i<40;i++){
    if(child.exitCode!==null) throw new Error("proxy exited early: "+stderr);
    try{health=await getHealth();break;}catch{}
    await new Promise((r)=>setTimeout(r,50));
  }
  assert.ok(health,"proxy health endpoint did not start");
  assert.equal(health.status,200);
  const body=JSON.parse(health.body);
  assert.deepEqual(body.docker_actions,["restart","load_image","candidate_run","candidate_remove"]);
  assert.deepEqual(body.candidate_networks,["wandora-core"]);
  assert.deepEqual(body.candidate_host_ports,[18090]);
  assert.equal(child.exitCode,null);
  console.log("DOCKER_PROXY_CANDIDATE_ACTIONS_STARTUP=GREEN");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve)=>child.once("exit",resolve));
}
