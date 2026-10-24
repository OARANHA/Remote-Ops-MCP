/**
 * Optional V2 platform-grant console. Existing TEAM_3 V1 routes remain intact.
 * Not mounted unless DSH_PLATFORM_ADMIN_ENABLED=1; the flag is OFF by default.
 * The parent admin router owns signed admin cookies, CSRF and audit.
 */
import path from "node:path";
import type {Router,Request,Response,RequestHandler} from "express";
import {env} from "../lib/env.js";
import {listClients,listSessions} from "../state/store.js";

type Operation="read"|"manage"|"revoke";
const OPERATIONS=new Set<Operation>(["read","manage","revoke"]);
const esc=(value:unknown)=>String(value??"").replace(/&/g,"&amp;")
 .replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const enabled=()=>process.env.DSH_PLATFORM_ADMIN_ENABLED==="1" &&
  env.AUTH_MODE==="oauth" && env.MOCK_MODE!=="1";
const words:Record<Operation,string>={
  read:"GRANT READ DSH PLATFORM",
  manage:"GRANT MANAGE DSH PLATFORM",
  revoke:"REVOKE DSH PLATFORM",
};
interface Subject {
 actor:string;clientId:string;sessionId:string;rootScope:"managed";
 actions:string[];operation:Operation;
}
interface GrantStore {
 putGrant:(subject:Subject)=>Promise<unknown>;
 revokeGrant:(subject:Subject)=>Promise<boolean>;
}
async function selectSubject(input:{
 sessionId:string;operation:Operation;confirmation:string;
}):Promise<Subject>{
 const mod=new URL("../../integrations/deepharness/platform-admin-grant-console-contract.mjs",import.meta.url);
 const selector=await import(mod.href) as {
  selectCurrentDshPlatformGrantSubject:(x:Record<string,unknown>)=>Subject;
 };
 return selector.selectCurrentDshPlatformGrantSubject({
  sessions:listSessions(),clients:listClients(),
  sessionId:input.sessionId,operation:input.operation,
  confirmation:input.confirmation,
 });
}
let cached:Promise<GrantStore>|undefined;
async function grantStore():Promise<GrantStore>{
 if(!cached){
  cached=(async()=>{
   const filename=process.env.DSH_PLATFORM_GRANT_STATE_FILE;
   const base=path.resolve(path.dirname(env.STATE_FILE));
   if(!filename||!path.isAbsolute(filename)||
      path.dirname(path.resolve(filename))!==base||
      path.resolve(filename)===path.resolve(env.STATE_FILE))throw Error("platform_state_unconfigured");
   const mod=new URL("../../integrations/deepharness/platform-admin-grant-store.mjs",import.meta.url);
   const impl=await import(mod.href) as {
    getDshPlatformGrantStore:(args:{file:string})=>GrantStore;
   };
   return impl.getDshPlatformGrantStore({file:filename});
  })().catch(error=>{cached=undefined;throw error;});
 }
 return cached;
}
function claimsCsrf(req:Request):string{
 return (req as Request&{adminClaims?:{csrf:string}}).adminClaims?.csrf??"";
}
export function installDshPlatformAdminRoutes(router:Router,dependencies:{
 requireCsrf:RequestHandler;
 adminAudit:(req:Request,tool:string,target?:string,
 result?:"ok"|"denied"|"error",errorCode?:string)=>void;
}):void{
 router.get("/deepharness-platform-grants",(req:Request,res:Response)=>{
  if(!enabled()){res.status(404).type("text/plain").send("Not found");return;}
  const now=Date.now();
  const clientIds=new Set(listClients().filter(c=>!c.revoked_at).map(c=>c.client_id));
  const options=listSessions().filter(s=>!s.revoked_at &&
   s.refresh_expires_at>now && clientIds.has(s.client_id))
   .slice(0,80).map(s=>`<option value="${esc(s.session_id)}">${esc(s.session_id)} (${esc(s.client_id)})</option>`).join("");
  res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DeepHarness V2 grants</title></head>
<body><main style="max-width:760px;margin:3rem auto;font:16px system-ui">
<h1>DeepHarness — administração V2</h1>
<p><a href="/admin">Voltar ao Admin</a></p>
<p>Somente escopo managed. Grants não ativam transporte nem ferramentas MCP.</p>
<form method="post" action="/admin/deepharness-platform-grants" autocomplete="off">
<input type="hidden" name="csrf" value="${esc(claimsCsrf(req))}">
<label>Sessão OAuth ativa: <select name="session_id" required>${options}</select></label>
<p><label>Operação: <select name="operation" required>
<option value="read">Leitura de workspaces, sessões e estados da equipe</option>
<option value="manage">Administração V2 (nove operações)</option>
<option value="revoke">Revogar grant V2</option></select></label></p>
<p>Confirmação exata: <code>${words.read}</code>, <code>${words.manage}</code> ou <code>${words.revoke}</code>.</p>
<input name="confirmation" required maxlength="64" autocomplete="off">
<button type="submit">Confirmar</button>
</form></main></body></html>`);
 });
 router.post("/deepharness-platform-grants",dependencies.requireCsrf,
  async(req:Request,res:Response)=>{
   if(!enabled()){res.status(404).type("text/plain").send("Not found");return;}
   try{
    const body=req.body as Record<string,unknown>;
    const operation=body?.operation as Operation;
    if(!OPERATIONS.has(operation)||typeof body?.session_id!=="string"||
       typeof body?.confirmation!=="string"||
       body.confirmation!==words[operation])throw Error("invalid_grant_request");
    const subject=await selectSubject({
     sessionId:body.session_id,operation,confirmation:body.confirmation,
    });
    const store=await grantStore();
    if(operation==="revoke")await store.revokeGrant(subject);
    else await store.putGrant(subject);
    dependencies.adminAudit(req,"admin.dsh_platform_"+operation,"deepharness-platform","ok");
    res.redirect(303,"/admin/deepharness-platform-grants");
   }catch{
    dependencies.adminAudit(req,"admin.dsh_platform_denied","deepharness-platform",
      "denied","CAPABILITY_DENIED");
    res.status(403).type("text/plain").send("DSH platform grant denied");
   }
  });
}
