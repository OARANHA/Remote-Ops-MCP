/**
 * Pure console-side selector for future DSH platform grants. Does not register
 * routes, apply grants or change OAuth. The authenticated admin console must
 * separately enforce its session, CSRF, reauthentication and audit controls.
 */
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const deny=()=>{throw Error("deepharness_platform_grant_admin_denied");};
const ACTIONS=Object.freeze({
  read:Object.freeze(["workspace.list","session.list","team.member.read"]),
  manage:Object.freeze(["workspace.list","workspace.create","workspace.rename",
    "session.list","team.member.read","session.create","team.member.create",
    "team.task.create","team.task.update"]),
  manage_skills:Object.freeze(["workspace.list","workspace.create","workspace.rename",
    "session.list","team.member.read","session.create","team.member.create","team.task.create","team.task.update","skills.list"]),
  revoke:Object.freeze([]),
});
const WORDS=Object.freeze({
  read:"GRANT READ DSH PLATFORM",
  manage:"GRANT MANAGE DSH PLATFORM",
  manage_skills:"GRANT MANAGE AND SKILLS DSH PLATFORM",
  revoke:"REVOKE DSH PLATFORM",
});
/** Identity comes from the real registered OAuth client/session, never fields
 *  supplied by the model. Operation selects the managed DSH root only. */
export function selectCurrentDshPlatformGrantSubject({
  sessions,clients,sessionId,operation,confirmation,now=Date.now(),
}={}){
  if(!Array.isArray(sessions)||!Array.isArray(clients)||
    typeof sessionId!=="string"||!ID.test(sessionId)||
    !Number.isSafeInteger(now)||!Object.hasOwn(ACTIONS,operation)||
    confirmation!==WORDS[operation])deny();
  const matches=sessions.filter(s=>s?.session_id===sessionId);
  if(matches.length!==1||typeof matches[0].client_id!=="string"||
    !ID.test(matches[0].client_id))deny();
  const session=matches[0];
  const currentClients=clients.filter(c=>c?.client_id===session.client_id);
  if(operation!=="revoke"){
    if(currentClients.length!==1||session.revoked_at||
      !Number.isSafeInteger(session.refresh_expires_at)||
      session.refresh_expires_at<=now||currentClients[0].revoked_at)deny();
  }
  const clientId=session.client_id;
  return Object.freeze({
    actor:"oauth:"+clientId+":"+sessionId.slice(0,12),
    clientId,sessionId,rootScope:"managed",
    actions:Object.freeze([...ACTIONS[operation]]),operation,
  });
}
