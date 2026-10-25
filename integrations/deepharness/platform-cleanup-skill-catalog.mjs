/**
 * Read-only bridge to DSH's official SessionSkillCatalog.list({sessionId}).
 * No filesystem access, no agent activation and no cleanup authorization.
 */
const deny=()=>{throw Error("deepharness_cleanup_skill_catalog_unavailable");};
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function createDshCleanupSkillReader({listSkills,authorizeRead}={}){
  if(typeof listSkills!=="function"||typeof authorizeRead!=="function")deny();
  return Object.freeze({
    async list({workspaceId,sessionId}={}){
      if(typeof workspaceId!=="string"||!ID.test(workspaceId)||
         typeof sessionId!=="string"||!ID.test(sessionId))deny();
      const scope=Object.freeze({operation:"skills.list",workspaceId,sessionId});
      await authorizeRead(scope);
      // Official API returns a session-scoped list; never infer complete
      // project/global filesystem roots from it.
      const raw=await listSkills({sessionId});
      if(!raw||typeof raw!=="object"||Array.isArray(raw)||
         !Array.isArray(raw.skills)||raw.skills.length>1000)deny();
      const seen=new Set(),skills=[];
      for(const s of raw.skills){
        if(!s||typeof s!=="object"||Array.isArray(s)||
          typeof s.name!=="string"||!/^[a-z0-9][a-z0-9-]{0,100}$/.test(s.name)||
          typeof s.description!=="string"||s.description.length>4096||
          typeof s.modelInvocable!=="boolean"||
          (s.path!==undefined&&(typeof s.path!=="string"||
             !s.path.startsWith("/")||s.path.includes("\0")||s.path.split("/").includes(".."))))deny();
        const key=s.name+"\0"+(s.path??"");
        if(seen.has(key))deny();
        seen.add(key);
        skills.push(Object.freeze({name:s.name,description:s.description,
          modelInvocable:s.modelInvocable,...(s.path===undefined?{}:{path:s.path})}));
      }
      await authorizeRead(scope);
      return Object.freeze({workspaceId,sessionId,skills:Object.freeze(skills),
        projectRootsComplete:false,globalRootsComplete:false,cleanupAuthorized:false});
    }
  });
}
