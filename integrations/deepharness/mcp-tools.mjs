/** MCP tool surface for the existing Remote-Ops OAuth session. */
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {composeDeepharnessReadWriteOverMtls} from "./composition.mjs";
import {createPersistentDshGrantStore} from "./persistent-grant-store.mjs";

const ID=z.string().min(1).max(256);
const UUID=z.string().uuid();
const deny=()=>{throw Error("deepharness_semantic_runtime_unavailable");};
let runtimePromise;

function caller(ctx) {
  return {actor:ctx.actor,clientId:ctx.clientId,sessionId:ctx.sessionId};
}

export function createDeepharnessToolDefs(policy) {
  if(typeof policy?.listTeams!=="function"||typeof policy?.readTeam!=="function"||
     typeof policy?.readChat!=="function"||typeof policy?.sendLeadInstruction!=="function")deny();
  return Object.freeze([
    {name:"dsh_list_teams",description:"List Agent Teams in one workspace for which this OAuth caller has an active team.read grant.",
      inputSchema:{workspaceId:ID},run:(args,ctx)=>policy.listTeams(caller(ctx),args)},
    {name:"dsh_get_team_status",description:"Read the authorized Lead's current Agent Team members and task projection.",
      inputSchema:{workspaceId:ID,leadSessionId:ID},run:(args,ctx)=>policy.readTeam(caller(ctx),args)},
    {name:"dsh_list_tasks",description:"List tasks from the authorized Lead's current Agent Team projection.",
      inputSchema:{workspaceId:ID,leadSessionId:ID},run:async(args,ctx)=>{
        const team=await policy.readTeam(caller(ctx),args);return {workspace_id:args.workspaceId,
          lead_session_id:args.leadSessionId,tasks:team.tasks};
      }},
    {name:"dsh_read_lead_chat",description:"Read a bounded page of text-only user and assistant messages from the authorized Lead session.",
      inputSchema:{workspaceId:ID,leadSessionId:ID,maxMessages:z.number().int().min(1).max(20).default(20)},
      run:(args,ctx)=>policy.readChat(caller(ctx),{workspaceId:args.workspaceId,
        leadSessionId:args.leadSessionId,limit:args.maxMessages??20})},
    {name:"dsh_send_lead_instruction",description:"Queue a text instruction to the authorized Lead. Returns an admission receipt, not completion.",
      inputSchema:{workspaceId:ID,leadSessionId:ID,instruction:z.string().min(1).max(4096),idempotencyKey:UUID},
      mutation:true,idempotent:true,run:(args,ctx)=>policy.sendLeadInstruction(caller(ctx),args)},
  ]);
}

export async function loadDeepharnessToolDefs() {
  if(process.env.DSH_SEMANTIC_ENABLED!=="1")return [];
  if(process.env.AUTH_MODE==="noauth")deny();
  const pin=process.env.DSH_BRIDGE_SERVER_FP_SHA256;
  if(typeof pin!=="string"||!/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(pin))deny();
  runtimePromise??=(async()=>{
    const [ca,cert,key]=await Promise.all([
      readFile("/app/secrets/dsh-bridge-ca.pem"),
      readFile("/app/secrets/dsh-bridge-client-cert.pem"),
      readFile("/app/secrets/dsh-bridge-client-key.pem"),
    ]);
    const grantStore=createPersistentDshGrantStore({file:"/app/data/deepharness-grants.json",
      audit:event=>console.log(JSON.stringify({ts:new Date().toISOString(),level:"info",source:"dsh-grant-store",...event}))});
    const policy=composeDeepharnessReadWriteOverMtls({tls:{ca,cert,key},serverFingerprintSha256:pin,grantStore});
    return createDeepharnessToolDefs(policy);
  })().catch(error=>{runtimePromise=undefined;throw error;});
  return runtimePromise;
}
