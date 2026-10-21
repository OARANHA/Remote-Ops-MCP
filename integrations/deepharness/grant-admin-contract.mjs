/**
 * Pure gate for console-managed, session-bound DeepHarness lab grants.
 * The console derives OAuth identity ONLY from the trusted live session store.
 * No arbitrary actor, clientId, workspace, lead or capability is accepted.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAD=/^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ACTIONS=Object.freeze({
  read:Object.freeze(["team.read","chat.read"]),
  instruct:Object.freeze(["team.read","chat.read","lead.instruct"]),
  revoke:Object.freeze([]),
});
const deny=()=>{throw Error("deepharness_grant_admin_denied");};

export function selectCurrentDshGrantSubject({
  sessions,clients,sessionId,workspaceId,leadSessionId,operation,confirmation,now=Date.now()
}={}) {
  if(!Array.isArray(sessions)||!Array.isArray(clients)||
    !ID.test(sessionId)||!UUID.test(workspaceId)||!LEAD.test(leadSessionId)||
    !Number.isSafeInteger(now)||typeof operation!=="string"||
    !Object.hasOwn(ACTIONS,operation))deny();
  const required={read:"GRANT READ TEAM_3",instruct:"GRANT INSTRUCT TEAM_3",revoke:"REVOKE TEAM_3"}[operation];
  if(confirmation!==required)deny();
  const session=sessions.find(s=>s.session_id===sessionId);
  if(!session||!ID.test(session.client_id))deny();
  const client=clients.find(c=>c.client_id===session.client_id);
  if(operation!=="revoke"&&(
    session.revoked_at||!Number.isSafeInteger(session.refresh_expires_at)||
    session.refresh_expires_at<=now||!client||client.revoked_at
  ))deny();
  const clientId=session.client_id;
  return Object.freeze({
    actor:`oauth:${clientId}:${sessionId.slice(0,12)}`,
    clientId,sessionId,workspaceId,leadSessionId,
    actions:[...ACTIONS[operation]],
    operation,
  });
}
