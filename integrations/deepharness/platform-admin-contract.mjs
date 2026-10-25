/**
 * V2 semantic platform contract. This is deliberately a DIFFERENT operation
 * from the existing TEAM_3-only "deepharness.semantic" endpoint. No adapter,
 * listener, login, grant, target or deployment is activated by this module.
 *
 * Payloads contain only a named DSH business action; never host paths,
 * arbitrary commands, URLs, OAuth claims, credentials or target IDs.
 */
const OP="deepharness.platform";
const deny=()=>{throw Error("deepharness_platform_contract_denied");};
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z][a-z0-9-]{1,47}$/;
const MAX_BYTES=16_384;
const ACTIONS=Object.freeze({
  listWorkspaces:"workspace.list",listSessionSkills:"skills.list",createWorkspace:"workspace.create",
  renameWorkspace:"workspace.rename",listWorkspaceSessions:"session.list",
  listTeamMemberStates:"team.member.read",
  createLeadSession:"session.create",createTeammate:"team.member.create",
  createTeamTask:"team.task.create",updateTeamTask:"team.task.update",
});
const exactly=(x,names)=>{
  if(!obj(x)||Object.keys(x).length!==names.length||
    names.some(key=>!Object.hasOwn(x,key))||
    Object.keys(x).some(key=>!names.includes(key)))deny();
};
const identity=x=>typeof x==="string"&&ID.test(x)?x:deny();
const uuid=x=>typeof x==="string"&&UUID.test(x)?x:deny();
const label=(x,max)=>{
  if(typeof x!=="string"||x.length===0||x.length>max||x.trim()!==x||
    /[\0\r\n]/.test(x))deny();return x;
};
function validateArgs(a){
  if(!obj(a)||!Object.hasOwn(ACTIONS,a.operation))deny();
  const op=a.operation;
  switch(op){
    case "listWorkspaces":
      exactly(a,["operation"]);break;
    case "listSessionSkills":
      exactly(a,["operation","workspaceId","sessionId"]);
      identity(a.workspaceId);identity(a.sessionId);break;
    case "createWorkspace":
      exactly(a,["operation","name","title","requestId"]);
      if(typeof a.name!=="string"||!SLUG.test(a.name))deny();
      label(a.title,120);uuid(a.requestId);break;
    case "renameWorkspace":
      exactly(a,["operation","workspaceId","title","requestId"]);
      identity(a.workspaceId);label(a.title,120);uuid(a.requestId);break;
    case "listWorkspaceSessions":
      exactly(a,["operation","workspaceId"]);identity(a.workspaceId);break;
    case "listTeamMemberStates":
      exactly(a,["operation","workspaceId","leadSessionId"]);
      identity(a.workspaceId);identity(a.leadSessionId);break;
    case "createLeadSession":
      exactly(a,["operation","workspaceId","agentPreset","requestId"]);
      identity(a.workspaceId);label(a.agentPreset,90);uuid(a.requestId);break;
    case "createTeammate":
      exactly(a,["operation","workspaceId","leadSessionId","name","description","prompt","provider","context","requestId"]);
      identity(a.workspaceId);identity(a.leadSessionId);
      label(a.name,80);label(a.description,500);label(a.prompt,4096);
      identity(a.provider);
      if(!["fresh","fork"].includes(a.context))deny();
      uuid(a.requestId);break;
    case "createTeamTask":
      exactly(a,["operation","workspaceId","leadSessionId","subject","description","requestId"]);
      identity(a.workspaceId);identity(a.leadSessionId);
      label(a.subject,240);label(a.description,1500);uuid(a.requestId);break;
    case "updateTeamTask":
      exactly(a,["operation","workspaceId","leadSessionId","taskId","expectedRevision","action","owner","requestId"]);
      identity(a.workspaceId);identity(a.leadSessionId);identity(a.taskId);
      if(!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<1||
        !["claim","release","complete","reopen","reassign"].includes(a.action))deny();
      if(a.owner!==null)identity(a.owner);
      if(a.action==="reassign"&&a.owner===null)deny();
      uuid(a.requestId);break;
    default:deny();
  }
  if(Buffer.byteLength(JSON.stringify(a),"utf8")>MAX_BYTES)deny();
  return Object.freeze({...a});
}
export function actionForDshPlatformOperation(op){
  return Object.hasOwn(ACTIONS,op)?ACTIONS[op]:deny();
}
export function validateDshPlatformEnvelope(value){
  exactly(value,["op","args"]);
  if(value.op!==OP)deny();
  const args=validateArgs(value.args);
  if(Buffer.byteLength(JSON.stringify({op:OP,args}),"utf8")>MAX_BYTES)deny();
  return Object.freeze({op:OP,args});
}
export function makeDshPlatformEnvelope(args){
  return validateDshPlatformEnvelope({op:OP,args});
}
