/**
 * Optional ChatGPT-facing V2 DeepHarness management tool definitions.
 * Factory only. NOT added to the running MCP registry until V2 OAuth grants,
 * private Agent Mesh transport and DSH host replay gate are composed.
 */
import {z} from "zod";

const ID=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const UUID=z.string().uuid();
const TEXT=(max)=>z.string().min(1).max(max);
const SLUG=z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
const ACTION=z.enum(["claim","release","complete","reopen","reassign"]);
const deny=()=>{throw Error("deepharness_platform_tools_unavailable");};

function trustedCaller(ctx){
  // The existing MCP middleware owns these values; never read them from tool
  // input or from the model's description. Policy verifies the full identity.
  if(!ctx||typeof ctx!=="object")deny();
  return Object.freeze({actor:ctx.actor,clientId:ctx.clientId,sessionId:ctx.sessionId});
}
export function createDshPlatformToolDefs(policy){
  if(typeof policy?.execute!=="function")deny();
  function tool(name,operation,description,inputSchema,mutation=false){
    return Object.freeze({
      name,description,inputSchema,
      ...(mutation?{mutation:true,idempotent:true}:{}),
      run:(args,ctx)=>policy.execute(trustedCaller(ctx),{operation,...args}),
    });
  }
  return Object.freeze([
    tool("dsh_list_workspaces","listWorkspaces",
      "Inventory accessible DeepHarness workspaces in the trusted managed root; no host paths exposed.",{}),
    tool("dsh_list_session_skills","listSessionSkills",
      "Read skills visible to an authorized DSH session; does not inventory all skill roots or authorize deletion.",
      {workspaceId:ID,sessionId:ID}),
    tool("dsh_create_workspace","createWorkspace",
      "Create or reuse a workspace beneath the fixed managed DSH projects directory.",
      {name:SLUG,title:TEXT(120),requestId:UUID},true),
    tool("dsh_rename_workspace","renameWorkspace",
      "Rename an existing authorized DSH workspace.",
      {workspaceId:ID,title:TEXT(120),requestId:UUID},true),
    tool("dsh_list_workspace_sessions","listWorkspaceSessions",
      "List session identities attached to one authorized DSH workspace.",{workspaceId:ID}),
    tool("dsh_list_team_member_states","listTeamMemberStates",
      "Read member identities and provisioning phases for one Lead in an authorized workspace; excludes prompts and diagnostics.",
      {workspaceId:ID,leadSessionId:ID}),
    tool("dsh_create_lead_session","createLeadSession",
      "Create a Lead session in an authorized DSH workspace using an existing agent preset.",
      {workspaceId:ID,agentPreset:TEXT(90),requestId:UUID},true),
    tool("dsh_create_teammate","createTeammate",
      "Add a teammate to an authorized Lead through the DSH TeamService.",
      {workspaceId:ID,leadSessionId:ID,name:TEXT(80),description:TEXT(500),
        prompt:TEXT(4096),provider:ID,context:z.enum(["fresh","fork"]),requestId:UUID},true),
    tool("dsh_create_team_task","createTeamTask",
      "Create one pending task in an authorized Lead's DSH Agent Team.",
      {workspaceId:ID,leadSessionId:ID,subject:TEXT(240),
        description:TEXT(1500),requestId:UUID},true),
    tool("dsh_update_team_task","updateTeamTask",
      "Apply one official compare-and-set Team task transition; pending tasks may require claim before complete.",
      {workspaceId:ID,leadSessionId:ID,taskId:ID,
        expectedRevision:z.number().int().min(1),action:ACTION,
        owner:ID.nullable(),requestId:UUID},true),
  ]);
}
