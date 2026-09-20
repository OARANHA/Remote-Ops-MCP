import { executeAgentOperation } from "./dist/agent/operations.js";

process.env.DOCKER_HOST="tcp://127.0.0.1:23751";
const list=await executeAgentOperation({op:"docker.list"});
if(list.code!==0||!list.stdout.includes("remote-ops-mcp")) throw new Error("broker docker list failed");
if(list.stdout.includes("supabase-db")) throw new Error("broker leaked nonallowlisted container");
console.log("AGENT_DOCKER_HOST_PROPAGATION=PASS");

process.env.DOCKER_HOST="tcp://10.0.0.1:2375";
let denied=false;
try { await executeAgentOperation({op:"docker.list"}); } catch(e) { denied=String(e).includes("docker_read_proxy_required"); }
if(!denied) throw new Error("unsafe docker host was not denied");
console.log("AGENT_DOCKER_HOST_FAIL_CLOSED=PASS");
console.log("AGENT_DOCKER_BROKER_ENV=GREEN");