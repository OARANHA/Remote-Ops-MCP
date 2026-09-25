import assert from "node:assert/strict";
import http from "node:http";
import { executeAgentOperation } from "./dist/agent/operations.js";

const seen=[];
const server=http.createServer(async(req,res)=>{
  const chunks=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
  seen.push({method:req.method,path:req.url,body:Buffer.concat(chunks).toString("utf8")});
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({status:"ok",code:0,stdout:"",stderr:""}));
});
await new Promise((resolve)=>server.listen(23751,"127.0.0.1",resolve));
process.env.DOCKER_HOST="tcp://127.0.0.1:23751";

try {
  let r=await executeAgentOperation({op:"docker.image_load",args:{path:"/opt/wandora/ops-workspace/candidate.tar"}},{timeoutMs:2000});
  assert.equal(r.code,0);
  assert.equal(seen.at(-1).path,"/ops/images/load");
  assert.deepEqual(JSON.parse(seen.at(-1).body),{path:"/opt/wandora/ops-workspace/candidate.tar"});

  r=await executeAgentOperation({op:"docker.candidate_run",args:{name:"wandora-web-candidate-test",image:"wandora/web:candidate-deadbeef",network:"wandora-core",hostPort:18090,containerPort:8080}},{timeoutMs:2000});
  assert.equal(r.code,0);
  assert.equal(seen.at(-1).path,"/ops/candidates/run");
  assert.deepEqual(JSON.parse(seen.at(-1).body),{name:"wandora-web-candidate-test",image:"wandora/web:candidate-deadbeef",network:"wandora-core",hostPort:18090,containerPort:8080});

  r=await executeAgentOperation({op:"docker.candidate_remove",args:{name:"wandora-web-candidate-test"}},{timeoutMs:2000});
  assert.equal(r.code,0);
  assert.equal(seen.at(-1).path,"/ops/candidates/wandora-web-candidate-test/remove");

  await assert.rejects(()=>executeAgentOperation({op:"docker.candidate_run",args:{name:"bad name",image:"wandora/web:candidate-x",network:"wandora-core",hostPort:18090,containerPort:8080}},{timeoutMs:2000}),/invalid_identifier/);
  console.log("DOCKER_CANDIDATE_AGENT_CONTRACT=GREEN");
} finally {
  await new Promise((resolve)=>server.close(resolve));
}
