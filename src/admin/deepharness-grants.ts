import type {Router,Request,Response,RequestHandler} from "express";
import { getTarget } from "../config/targets.js";
import { validateAgentTargetAgainstPreset } from "../config/capability-baseline.js";
import { agentConnectionStatus } from "../agent/gateway.js";
import { effectiveTargetEnabled,listSessions,listClients } from "../state/store.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAD=/^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deny=()=>{throw Error("deepharness_grant_admin_unavailable");};
const escapeHtml=(s:unknown)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
 .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");

function requireConfiguredLab() {
  if(process.env.DSH_SEMANTIC_ENABLED!=="1"||
     process.env.DSH_SEMANTIC_TRANSPORT!=="agent-mesh-lab"||
     process.env.DSH_SEMANTIC_AGENT_TARGET_ID!=="deepharness-semantic-lab")deny();
  const workspaceId=process.env.DSH_GRANT_WORKSPACE_ID;
  const leadSessionId=process.env.DSH_GRANT_LEAD_SESSION_ID;
  if(!workspaceId||!UUID.test(workspaceId)||!leadSessionId||!LEAD.test(leadSessionId))deny();
  const target=getTarget("deepharness-semantic-lab");
  if(!target||!target.enabled||!effectiveTargetEnabled(target.id,target.enabled)||
     !validateAgentTargetAgainstPreset(target,"deepharness-semantic-lab").valid||
     !target.deviceId||!agentConnectionStatus(target.deviceId).online)deny();
  return {workspaceId,leadSessionId};
}

type GrantIdentity={actor:string;clientId:string;sessionId:string;workspaceId:string;leadSessionId:string;actions:string[];operation:string};
type GrantStore={
  putGrant:(input:GrantIdentity)=>Promise<unknown>;
  revokeGrant:(input:GrantIdentity)=>Promise<boolean>;
};
async function adminGrantStore():Promise<GrantStore> {
  const u=new URL("../../integrations/deepharness/grant-store-runtime.mjs",import.meta.url);
  const m=await import(u.href) as {getDshGrantStore:()=>GrantStore};
  return m.getDshGrantStore();
}
async function adminGrantSubject(input:Record<string,unknown>,scope:{workspaceId:string;leadSessionId:string}):Promise<GrantIdentity> {
  const u=new URL("../../integrations/deepharness/grant-admin-contract.mjs",import.meta.url);
  const m=await import(u.href) as {selectCurrentDshGrantSubject:(input:Record<string,unknown>)=>GrantIdentity};
  return m.selectCurrentDshGrantSubject({
    sessions:listSessions(),clients:listClients(),
    sessionId:input.session_id,operation:input.operation,confirmation:input.confirmation,
    ...scope,
  });
}
function adminCsrf(req:Request) {
  return (req as Request&{adminClaims?:{csrf:string}}).adminClaims?.csrf??"";
}

export function installDshGrantAdminRoutes(router:Router,dependencies:{
  requireCsrf:RequestHandler;
  adminAudit:(req:Request,tool:string,target?:string,
    result?:"ok"|"denied"|"error",errorCode?:string)=>void;
}):void {
  // These routes inherit requireAdmin and the strict admin security headers.
  router.get("/deepharness-grants",(req:Request,res:Response)=>{
    let scope;
    try{scope=requireConfiguredLab();}
    catch{res.status(404).type("text/plain").send("DSH grants unavailable");return;}
    const now=Date.now();
    const clients=new Set(listClients().filter(c=>!c.revoked_at).map(c=>c.client_id));
    const sessions=listSessions().filter(s=>!s.revoked_at&&s.refresh_expires_at>now&&clients.has(s.client_id));
    const options=sessions.slice(0,80).map(s=>`<option value="${escapeHtml(s.session_id)}">${escapeHtml(s.session_id)} (${escapeHtml(s.client_id)})</option>`).join("");
    const csrf=escapeHtml(adminCsrf(req));
    const body=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Grants DeepHarness — Wandora</title></head>
<body><main style="max-width:800px;margin:3rem auto;font:16px system-ui">
<h1>DeepHarness — grants da sessão OAuth</h1>
<p><a href="/admin">Voltar ao Admin</a></p>
<p>Somente um Lead de laboratório. Não concede acesso genérico à VPS.</p>
<p><strong>Workspace:</strong> <code>${escapeHtml(scope.workspaceId)}</code></p>
<p><strong>Lead:</strong> <code>${escapeHtml(scope.leadSessionId)}</code></p>
<form method="post" action="/admin/deepharness-grants" autocomplete="off">
<input type="hidden" name="csrf" value="${csrf}">
<label>Sessão OAuth ativa (não o aplicativo inteiro):
<select required name="session_id">${options}</select></label>
<p><label>Ação: <select required name="operation">
<option value="read">Conceder leitura de Teams e chat</option>
<option value="instruct">Conceder leitura e envio de instruções ao Lead</option>
<option value="revoke">Revogar todas as permissões DSH desta sessão</option>
</select></label></p>
<p>Digite exatamente a confirmação correspondente à ação:</p>
<p><code>GRANT READ TEAM_3</code> — leitura</p>
<p><code>GRANT INSTRUCT TEAM_3</code> — instruções</p>
<p><code>REVOKE TEAM_3</code> — revogação</p>
<input required name="confirmation" maxlength="64" placeholder="Confirmação exata">
<button type="submit">Aplicar à sessão selecionada</button>
</form>
<p>Grants são vinculados ao OAuth client, session ID, workspace, Lead e ação. Reautorizar o ChatGPT pode criar outra sessão que exigirá novo grant.</p>
</main></body></html>`;
    res.type("html").send(body);
  });

  router.post("/deepharness-grants",dependencies.requireCsrf,async(req:Request,res:Response)=>{
    try{
      const scope=requireConfiguredLab();
      const identity=await adminGrantSubject(req.body as Record<string,unknown>,scope);
      const store=await adminGrantStore();
      if(identity.operation==="revoke")await store.revokeGrant(identity);
      else await store.putGrant(identity);
      dependencies.adminAudit(req,"admin.dsh_grant_"+identity.operation,"deepharness-semantic-lab","ok");
      res.redirect(303,"/admin/deepharness-grants");
    }catch{
      dependencies.adminAudit(req,"admin.dsh_grant_denied","deepharness-semantic-lab","denied","CAPABILITY_DENIED");
      res.status(403).type("text/plain").send("DSH grant denied");
    }
  });
}
