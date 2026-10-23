/**
 * DSH 0.2.1-alpha.2 official host-side Workspace/Team administration.
 * NOT an MCP tool, HTTP route or listener. All dependencies must be installed
 * by the trusted DSH Host; OAuth scopes and durable mutation grants must be
 * supplied by the caller-side composition, never accepted in user arguments.
 */
import {join,resolve,sep} from "node:path";
import {createDshCleanupSkillReader} from "./platform-cleanup-skill-catalog.mjs";
const deny=()=>{throw Error("dsh_platform_admin_denied");};
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SLUG=/^[a-z][a-z0-9-]{1,47}$/;
const id=x=>typeof x==="string"&&ID.test(x)?x:deny();
function exact(x,names){
  if(!obj(x)||Object.keys(x).length!==names.length||
    Object.keys(x).some(k=>!names.includes(k))||names.some(k=>!Object.hasOwn(x,k)))deny();
}
function label(x,max){
  if(typeof x!=="string"||!x||x.trim()!==x||x.length>max||/[\r\n\0]/.test(x))deny();
  return x;
}
function view(ws){
  if(!obj(ws)||!ID.test(ws.id)||typeof ws.title!=="string"||
    !Array.isArray(ws.sessionIds)||ws.sessionIds.length>10000||
    ws.sessionIds.some(x=>!ID.test(x)))deny();
  return Object.freeze({workspaceId:ws.id,title:ws.title.slice(0,120),
    sessionCount:ws.sessionIds.length,createdAt:ws.createdAt??null,updatedAt:ws.updatedAt??null});
}
/**
 * withAuthorizedWrite must atomically check current admin grants at commit
 * and serialize revocation with mutation. There is no permissive fallback.
 * workspaceParent is a trusted operator path, never provided by an MCP caller.
 */
export function createOfficialDshPlatformAdmin({
  workspaceRegistry,workspaceController,directoryPickerController,
  sessionController,agentTeams,sessionSkillCatalog,workspaceParent,authorizeRead,withAuthorizedWrite,auditStage,
}={}){
  if(typeof authorizeRead!=="function"||typeof withAuthorizedWrite!=="function"||
    typeof workspaceRegistry?.list!=="function"||
    typeof workspaceRegistry?.get!=="function"||
    typeof workspaceRegistry?.resolveByPath!=="function"||
    typeof workspaceController?.create!=="function"||
    typeof workspaceController?.rename!=="function"||
    typeof directoryPickerController?.createDirectory!=="function"||
    typeof sessionController?.create!=="function"||
    typeof sessionController?.resolveAgent!=="function"||
    typeof agentTeams?.createTask!=="function"||
    typeof agentTeams?.updateTask!=="function"||
    typeof workspaceParent!=="string"||!workspaceParent.startsWith("/")||
    resolve(workspaceParent)!==workspaceParent||workspaceParent==="/")deny();
  const root=workspaceParent;
  function owned(ws){
    if(!ws||typeof ws.path!=="string"||!resolve(ws.path).startsWith(root+sep))deny();
    return ws;
  }
  const workspace=workspaceId=>owned(workspaceRegistry.get(id(workspaceId)));
  function lead(ws,leadSessionId){
    const result=id(leadSessionId);
    if(!Array.isArray(ws.sessionIds)||!ws.sessionIds.includes(result))deny();
    return result;
  }
  async function read(operation,scope,work){
    await authorizeRead(Object.freeze({operation,...scope}));
    const result=await work();
    await authorizeRead(Object.freeze({operation,...scope}));
    return result;
  }
  const write=(operation,scope,work)=>
    withAuthorizedWrite(Object.freeze({operation,...scope}),work);
  // Optional official session-addressed skill catalog. Kept inert until an
  // independently scoped skills.list grant and private transport are wired.
  const skillReader=sessionSkillCatalog===undefined?undefined:
    createDshCleanupSkillReader({
      listSkills:({sessionId})=>sessionSkillCatalog.list({sessionId},new AbortController().signal),
      authorizeRead:scope=>authorizeRead(scope),
    });
  return Object.freeze({
    ...(skillReader===undefined?{}:{async listSessionSkills(input){
      exact(input,["workspaceId","sessionId"]);
      const ws=workspace(input.workspaceId);
      lead(ws,input.sessionId);
      return skillReader.list({workspaceId:ws.id,sessionId:input.sessionId});
    }}),
    async listWorkspaces(){
      return read("workspace.list",{},()=>{
        const all=workspaceRegistry.list();
        if(!Array.isArray(all)||all.length>5000)deny();
        const selected=all.filter(ws=>typeof ws?.path==="string"&&
          resolve(ws.path).startsWith(root+sep));
        if(selected.length>500)deny();
        return Object.freeze(selected.map(view));
      });
    },
    async createWorkspace(input){
      exact(input,["name","title"]);
      if(typeof input.name!=="string"||!SLUG.test(input.name))deny();
      const title=label(input.title,120),path=join(root,input.name);
      if(!path.startsWith(root+sep))deny();
      return write("workspace.create",{},async()=>{
        const existing=await workspaceRegistry.resolveByPath(path).catch(()=>undefined);
        if(existing){
          owned(existing);
          if(existing.title!==title)deny();
          return {created:false,workspace:view(existing)};
        }
        const createdPath=await directoryPickerController.createDirectory(root,input.name);
        if(createdPath!==path)deny();
        const created=await workspaceController.create({path});
        if(!obj(created?.workspace)||created.workspace.path!==path)deny();
        if(created.workspace.title!==title){
          await workspaceController.rename({workspaceId:created.workspace.workspaceId,title});
        }
        return {created:created.created===true,workspace:view(workspace(created.workspace.workspaceId))};
      });
    },
    async renameWorkspace(input){
      exact(input,["workspaceId","title"]);
      const ws=workspace(input.workspaceId),title=label(input.title,120);
      return write("workspace.rename",{workspaceId:ws.id},async()=>{
        const result=await workspaceController.rename({workspaceId:ws.id,title});
        if(result?.workspace?.workspaceId!==ws.id)deny();
        return view(workspace(ws.id));
      });
    },
    async createLeadSession(input){
      exact(input,["workspaceId","agentPreset"]);
      const ws=workspace(input.workspaceId),agentPreset=label(input.agentPreset,90);
      return write("session.create",{workspaceId:ws.id},async()=>{
        const result=await sessionController.create({workspaceId:ws.id,agentPreset});
        if(!ID.test(result?.sessionId)||!workspace(ws.id).sessionIds.includes(result.sessionId))deny();
        return Object.freeze({workspaceId:ws.id,leadSessionId:result.sessionId});
      });
    },
    async listWorkspaceSessions(input){
      exact(input,["workspaceId"]);
      const ws=workspace(input.workspaceId);
      return read("session.list",{workspaceId:ws.id},()=>{
        const current=workspace(ws.id);
        if(!Array.isArray(current.sessionIds)||current.sessionIds.length>10000)deny();
        return Object.freeze([...current.sessionIds].map(id));
      });
    },
    async createTeammate(input){
      exact(input,["workspaceId","leadSessionId","name","description","prompt","provider","context"]);
      const ws=workspace(input.workspaceId),leadSessionId=lead(ws,input.leadSessionId);
      const name=label(input.name,80),description=label(input.description,500);
      const prompt=label(input.prompt,4096),provider=id(input.provider);
      if(!["fresh","fork"].includes(input.context))deny();
      return write("team.member.create",{workspaceId:ws.id,leadSessionId},async()=>{
        lead(workspace(ws.id),leadSessionId);
        // Only fixed stage labels leave this adapter; never emit prompts,
        // provider credentials, session identities or thrown error messages.
        let stage="resolve_agent";
        try{
          const resolved=await sessionController.resolveAgent(leadSessionId);
          if(!resolved?.agent||resolved.error||typeof agentTeams.spawnTeammate!=="function")deny();
          stage="spawn_teammate";
          const created=await agentTeams.spawnTeammate(resolved.agent,{
            name,description,prompt:[{type:"text",text:prompt}],
            context:input.context,provider,signal:new AbortController().signal,
          });
          stage="validate_member";
          const member=created?.member;
          if(!ID.test(member?.id)||member?.name!==name||member?.role!=="teammate")deny();
          return Object.freeze({workspaceId:ws.id,leadSessionId,
            member:{id:member.id,name:member.name,role:"teammate",phase:member.phase}});
        }catch(error){
          try{auditStage?.({operation:"team.member.create",stage});}catch{}
          throw error;
        }
      });
    },
    async createTeamTask(input){
      exact(input,["workspaceId","leadSessionId","subject","description"]);
      const ws=workspace(input.workspaceId),leadSessionId=lead(ws,input.leadSessionId);
      const subject=label(input.subject,240),description=label(input.description,1500);
      return write("team.task.create",{workspaceId:ws.id,leadSessionId},async()=>{
        lead(workspace(ws.id),leadSessionId);
        const resolved=await sessionController.resolveAgent(leadSessionId);
        if(!resolved?.agent||resolved.error)deny();
        const task=await agentTeams.createTask(resolved.agent,{subject,description});
        if(!ID.test(task?.id)||!Number.isSafeInteger(task.revision))deny();
        return Object.freeze({taskId:task.id,revision:task.revision,status:task.status});
      });
    },
    async updateTeamTask(input){
      exact(input,["workspaceId","leadSessionId","taskId","expectedRevision","action","owner"]);
      const ws=workspace(input.workspaceId),leadSessionId=lead(ws,input.leadSessionId);
      const taskId=id(input.taskId),revision=input.expectedRevision;
      if(!Number.isSafeInteger(revision)||revision<1||
        !["claim","release","complete","reopen","reassign"].includes(input.action)||
        (input.owner!==null&&(typeof input.owner!=="string"||!ID.test(input.owner)))||
        (input.action==="reassign"&&input.owner===null))deny();
      return write("team.task.update",{workspaceId:ws.id,leadSessionId},async()=>{
        lead(workspace(ws.id),leadSessionId);
        const resolved=await sessionController.resolveAgent(leadSessionId);
        if(!resolved?.agent||resolved.error)deny();
        const task=await agentTeams.updateTask(resolved.agent,{
          taskId,expectedRevision:revision,action:input.action,
          ...(input.owner===null?{}:{owner:input.owner}),
        });
        if(task?.id!==taskId||!Number.isSafeInteger(task.revision)||task.revision<=revision)deny();
        return Object.freeze({taskId,revision:task.revision,status:task.status});
      });
    },
  });
}
