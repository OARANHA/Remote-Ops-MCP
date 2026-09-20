import crypto from "node:crypto";
import fs from "node:fs";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { env } from "../lib/env.js";
import { getTarget, listTargets } from "../config/targets.js";
import { getTransport } from "../transport.js";
import { closeTargetPool } from "../ssh/pool.js";
import { audit } from "../audit/audit.js";
import {
  activeSessionCount,
  effectiveTargetEnabled,
  getTargetActivity,
  getTargetControl,
  listClients,
  listSessions,
  recordTargetProbe,
  revokeAllClients,
  revokeClient,
  revokeSession,
  setTargetEnabled,
  usageForMonth,
} from "../state/store.js";

const ADMIN_COOKIE = "remote_ops_admin";
interface AdminClaims { iat: number; exp: number; csrf: string; }

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) { crypto.timingSafeEqual(aa, aa); return false; }
  return crypto.timingSafeEqual(aa, bb);
}
function sign(value: string): string { return crypto.createHmac("sha256", env.AUTH_SECRET!).update(value).digest("base64url"); }
function makeAdminToken(): string {
  const now = Math.floor(Date.now() / 1000), claims: AdminClaims = { iat: now, exp: now + env.ADMIN_SESSION_HOURS * 3600, csrf: crypto.randomBytes(24).toString("base64url") };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url"); return `${body}.${sign(body)}`;
}
function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function readAdminClaims(req: Request): AdminClaims | null {
  const token = parseCookies(req)[ADMIN_COOKIE]; if (!token) return null;
  const [body, sig] = token.split("."); if (!body || !sig || !safeEqual(sign(body), sig)) return null;
  try { const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AdminClaims; return c && c.exp > Math.floor(Date.now()/1000) && typeof c.csrf === "string" ? c : null; } catch { return null; }
}
function secureCookie(): boolean { try { return new URL(env.PUBLIC_BASE_URL).protocol === "https:"; } catch { return true; } }
function setAdminCookie(res: Response, token: string): void {
  const p = [`${ADMIN_COOKIE}=${encodeURIComponent(token)}`, "Path=/admin", `Max-Age=${env.ADMIN_SESSION_HOURS*3600}`, "HttpOnly", "SameSite=Strict"]; if (secureCookie()) p.push("Secure"); res.setHeader("Set-Cookie", p.join("; "));
}
function clearAdminCookie(res: Response): void { const p=[`${ADMIN_COOKIE}=`,"Path=/admin","Max-Age=0","HttpOnly","SameSite=Strict"]; if(secureCookie())p.push("Secure"); res.setHeader("Set-Cookie",p.join("; ")); }
function adminHeaders(res: Response): void {
  res.setHeader("Cache-Control","no-store"); res.setHeader("Pragma","no-cache"); res.setHeader("X-Frame-Options","DENY"); res.setHeader("X-Content-Type-Options","nosniff"); res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const claims=readAdminClaims(req); if(!claims){res.redirect(303,"/admin/login");return;} (req as Request & {adminClaims?:AdminClaims}).adminClaims=claims; next();
}
function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const claims=(req as Request & {adminClaims?:AdminClaims}).adminClaims ?? readAdminClaims(req), token=String((req.body as Record<string,unknown>|undefined)?.csrf ?? "");
  if(!claims||!token||!safeEqual(token,claims.csrf)){res.status(403).type("text/plain").send("CSRF validation failed");return;} next();
}
function loginLimiter(max=10,windowMs=5*60_000){const hits=new Map<string,number[]>();return(req:Request,res:Response,next:NextFunction)=>{const key=req.ip??"unknown",now=Date.now(),a=(hits.get(key)??[]).filter(x=>now-x<windowMs);if(a.length>=max){res.status(429).type("text/plain").send("Muitas tentativas. Aguarde alguns minutos.");return;}a.push(now);hits.set(key,a);next();};}
function fmtTs(ts?:number):string{return ts?new Date(ts).toISOString().replace("T"," ").replace(".000Z","Z"):"Nunca";}
function readAuditTail(limit=25):Array<Record<string,unknown>>{
  try{const st=fs.statSync(env.AUDIT_FILE),start=Math.max(0,st.size-128*1024),fd=fs.openSync(env.AUDIT_FILE,"r");try{const b=Buffer.alloc(st.size-start);fs.readSync(fd,b,0,b.length,start);return b.toString("utf8").split("\n").filter(Boolean).slice(-limit).reverse().flatMap(line=>{try{return[JSON.parse(line) as Record<string,unknown>];}catch{return[];}});}finally{fs.closeSync(fd);}}catch{return[];}
}
function badge(label:string,tone:"green"|"red"|"amber"|"gray"):string{return`<span class="badge ${tone}">${esc(label)}</span>`;}
function adminAudit(req:Request,tool:string,target?:string,result:"ok"|"denied"|"error"="ok",errorCode?:string):void{const requestId=(req as Request & {requestId?:string}).requestId??"admin";audit({ts:new Date().toISOString(),request_id:requestId,actor:"admin",target,tool,mutation:true,duration_ms:0,result,error_code:errorCode},{countUsage:false});}

function shell(title:string,body:string,claims?:AdminClaims):string{return`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Remote Ops MCP</title><style>
:root{color-scheme:dark;--bg:#09090b;--panel:#141416;--border:#2a2a2f;--muted:#8b8b95;--text:#f4f4f5;--green:#34d399;--red:#fb7185}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.layout{min-height:100vh;display:grid;grid-template-columns:230px 1fr}.side{border-right:1px solid var(--border);padding:20px 14px;position:sticky;top:0;height:100vh;background:#0b0b0d}.brand{display:flex;align-items:center;gap:10px;font-weight:760;padding:4px 8px 22px}.logo{width:28px;height:28px;border:1px solid #3f3f46;border-radius:7px;display:grid;place-items:center;font-weight:800}.nav a{display:block;color:#a1a1aa;text-decoration:none;padding:10px 12px;border-radius:9px;margin:3px 0;font-size:14px}.nav a:hover,.nav a.active{background:#17171a;color:#fff}.main{padding:34px;max-width:1280px;width:100%}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px}h1{font-size:27px;margin:0 0 7px}.sub{color:var(--muted);font-size:14px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 24px}.metric,.card{background:var(--panel);border:1px solid var(--border);border-radius:14px}.metric{padding:16px}.metric .n{font-size:25px;font-weight:760;margin-top:6px}.metric .k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.card{margin:14px 0;overflow:hidden}.card h2{font-size:14px;margin:0;padding:15px 17px;border-bottom:1px solid var(--border)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:13px 17px;border-bottom:1px solid #222226;font-size:13px;vertical-align:middle}th{color:#a1a1aa;font-weight:600;background:#111113}tr:last-child td{border-bottom:0}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.muted{color:var(--muted)}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700;border:1px solid}.badge.green{color:#86efac;background:#052e1b;border-color:#14532d}.badge.red{color:#fda4af;background:#4c0519;border-color:#881337}.badge.amber{color:#fde68a;background:#422006;border-color:#713f12}.badge.gray{color:#d4d4d8;background:#27272a;border-color:#3f3f46}.actions{display:flex;gap:7px;flex-wrap:wrap}.btn{appearance:none;border:1px solid #3f3f46;background:#202024;color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer}.btn.red{border-color:#7f1d1d;background:#2b0b10;color:#fecdd3}.btn.green{border-color:#166534;background:#082a18;color:#bbf7d0}.btn.primary{border-color:#1d4ed8;background:#172554;color:#bfdbfe}.empty{padding:24px;color:var(--muted);font-size:13px}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px;background:#71717a}.dot.on{background:var(--green)}.dot.off{background:var(--red)}.footer{color:#52525b;font-size:11px;margin-top:26px}.loginwrap{min-height:100vh;display:grid;place-items:center;padding:16px}.login{width:100%;max-width:390px;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:28px}.login h1{font-size:20px}.login input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #3f3f46;background:#09090b;color:#fff;margin:12px 0}.login button{width:100%;padding:11px;border-radius:9px;border:0;background:#2563eb;color:#fff;font-weight:700}.err{padding:9px 11px;border-radius:8px;background:#450a0a;color:#fecaca;border:1px solid #7f1d1d;font-size:12px;margin:12px 0}@media(max-width:900px){.layout{grid-template-columns:1fr}.side{display:none}.main{padding:20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}table{display:block;overflow-x:auto}}@media(max-width:520px){.grid{grid-template-columns:1fr}.top{display:block}}
</style></head><body>${claims?`<div class="layout"><aside class="side"><div class="brand"><div class="logo">R</div><div>Remote Ops MCP</div></div><nav class="nav"><a class="active" href="#devices">Devices</a><a href="#clients">Clients</a><a href="#usage">Usage</a><a href="#audit">Audit</a><a href="#settings">Settings</a></nav></aside><main class="main">${body}</main></div>`:body}</body></html>`;}
function loginPage(error?:string):string{return shell("Admin",`<div class="loginwrap"><main class="login"><h1>Remote Ops MCP</h1><p class="sub">Console administrativo</p>${error?`<div class="err">${esc(error)}</div>`:""}<form method="post" action="/admin/login"><input type="password" name="password" required autofocus autocomplete="current-password" placeholder="Senha administrativa"><button type="submit">Entrar</button></form><p class="footer">A administração é separada do endpoint MCP e não exibe segredos de infraestrutura.</p></main></div>`);}

function dashboardPage(claims:AdminClaims,notice?:string):string{
  const now=Date.now(),targets=listTargets(),clients=listClients(),sessions=listSessions(),usage=usageForMonth(),audit=readAuditTail(),csrf=esc(claims.csrf),activeSessions=activeSessionCount();
  const deviceRows=targets.map(t=>{const control=getTargetControl(t.id),enabled=effectiveTargetEnabled(t.id,t.enabled),a=getTargetActivity(t.id),recent=a?.last_seen_at?now-a.last_seen_at<10*60_000:false,online=enabled&&recent&&!!a?.last_ok_at&&(!a.last_error_at||a.last_ok_at>=a.last_error_at),offline=enabled&&recent&&!!a?.last_error_at&&(!a.last_ok_at||a.last_error_at>a.last_ok_at),status=!enabled?badge("Revoked","red"):online?badge("Online","green"):offline?badge("Issue","amber"):badge("Unknown","gray"),dot=!enabled||offline?"off":online?"on":"unknown";return`<tr><td><span class="dot ${dot}"></span><strong>${esc(t.id)}</strong><div class="muted">${esc(t.environment)} · ${esc(t.capabilityProfile)}</div></td><td>${status}</td><td>${esc(fmtTs(a?.last_seen_at))}<div class="muted">${esc(a?.last_tool??"sem probe")}</div></td><td>${esc(t.transport)}</td><td><div class="actions"><form method="post" action="/admin/targets/${encodeURIComponent(t.id)}/check"><input type="hidden" name="csrf" value="${csrf}"><button class="btn primary">Check</button></form>${enabled?`<form method="post" action="/admin/targets/${encodeURIComponent(t.id)}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="btn red">Revoke</button></form>`:`<form method="post" action="/admin/targets/${encodeURIComponent(t.id)}/enable"><input type="hidden" name="csrf" value="${csrf}"><button class="btn green">Enable</button></form>`}</div>${control?.reason?`<div class="muted">${esc(control.reason)}</div>`:""}</td></tr>`;}).join("");
  const clientRows=clients.map(c=>{const all=sessions.filter(s=>s.client_id===c.client_id),active=activeSessionCount(c.client_id),status=c.revoked_at?badge("Revoked","red"):active>0?badge("Authorized","green"):badge("Idle","gray");return`<tr><td><strong>${esc(c.client_name||"MCP client")}</strong><div class="mono muted">${esc(c.client_id)}</div></td><td>${status}<div class="muted">${active} sessão(ões) ativa(s)</div></td><td>${esc(fmtTs(c.last_seen_at??c.created_at))}</td><td>${all.length}</td><td>${c.revoked_at?`<span class="muted">revogado ${esc(fmtTs(c.revoked_at))}</span>`:`<form method="post" action="/admin/clients/${encodeURIComponent(c.client_id)}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="btn red">Revoke</button></form>`}</td></tr>`;}).join("");
  const sessionRows=sessions.slice(0,30).map(s=>{const revoked=!!s.revoked_at,expired=s.refresh_expires_at<now,status=revoked?badge("Revoked","red"):expired?badge("Expired","gray"):badge("Active","green");return`<tr><td class="mono">${esc(s.session_id)}</td><td class="mono muted">${esc(s.client_id)}</td><td>${status}</td><td>${esc(fmtTs(s.last_seen_at))}</td><td>${revoked||expired?"":`<form method="post" action="/admin/sessions/${encodeURIComponent(s.session_id)}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="btn red">Revoke</button></form>`}</td></tr>`;}).join("");
  const auditRows=audit.map(e=>`<tr><td>${esc(e.ts)}</td><td class="mono">${esc(e.tool)}</td><td>${esc(e.target??"-")}</td><td>${esc(e.actor??"-")}</td><td>${e.result==="ok"?badge("ok","green"):e.result==="denied"?badge("denied","amber"):badge("error","red")}${e.error_code?`<div class="mono muted">${esc(e.error_code)}</div>`:""}</td><td>${esc(e.duration_ms)} ms</td></tr>`).join("");
  const body=`<div class="top"><div><h1>Devices</h1><div class="sub">Máquinas e clientes MCP autorizados pelo Remote Ops.</div></div><div class="actions"><form method="post" action="/admin/revoke-all"><input type="hidden" name="csrf" value="${csrf}"><button class="btn red">Revoke all clients</button></form><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="btn">Sair</button></form></div></div>${notice?`<div class="err" style="background:#132a1d;border-color:#166534;color:#bbf7d0">${esc(notice)}</div>`:""}<section id="usage" class="grid"><div class="metric"><div class="k">Tool calls / mês</div><div class="n">${usage.tool_calls}</div></div><div class="metric"><div class="k">Sessões ativas</div><div class="n">${activeSessions}</div></div><div class="metric"><div class="k">Negadas</div><div class="n">${usage.denied}</div></div><div class="metric"><div class="k">Erros</div><div class="n">${usage.error}</div></div></section><section id="devices" class="card"><h2>Your devices</h2>${deviceRows?`<table><thead><tr><th>Device</th><th>Status</th><th>Last seen</th><th>Transport</th><th>Actions</th></tr></thead><tbody>${deviceRows}</tbody></table>`:`<div class="empty">Nenhum target.</div>`}</section><section id="clients" class="card"><h2>MCP clients</h2>${clientRows?`<table><thead><tr><th>Client</th><th>Status</th><th>Last seen</th><th>Sessions</th><th>Actions</th></tr></thead><tbody>${clientRows}</tbody></table>`:`<div class="empty">Nenhum cliente OAuth registrado.</div>`}</section><section class="card"><h2>Recent sessions</h2>${sessionRows?`<table><thead><tr><th>Session</th><th>Client</th><th>Status</th><th>Last seen</th><th>Action</th></tr></thead><tbody>${sessionRows}</tbody></table>`:`<div class="empty">Nenhuma sessão.</div>`}</section><section id="audit" class="card"><h2>Recent audit</h2>${auditRows?`<table><thead><tr><th>Time</th><th>Tool</th><th>Target</th><th>Actor</th><th>Result</th><th>Duration</th></tr></thead><tbody>${auditRows}</tbody></table>`:`<div class="empty">Sem eventos.</div>`}</section><section id="settings" class="card"><h2>Connection</h2><table><tbody><tr><td>MCP endpoint</td><td class="mono">${esc(`${env.PUBLIC_BASE_URL}/mcp`)}</td></tr><tr><td>OAuth discovery</td><td class="mono">${esc(`${env.PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`)}</td></tr><tr><td>Auth mode</td><td>${esc(env.AUTH_MODE)}</td></tr><tr><td>Mock mode</td><td>${env.MOCK_MODE==="1"?badge("ON","amber"):badge("OFF","green")}</td></tr></tbody></table></section><div class="footer">Admin UI never renders host addresses, SSH key paths or secrets.</div>`;
  return shell("Admin",body,claims);
}

export function adminRouter():Router{
  const r=Router(); r.use((_req,res,next)=>{adminHeaders(res);next();});
  r.get("/login",(req,res)=>{if(readAdminClaims(req)){res.redirect(303,"/admin");return;}res.type("html").send(loginPage());});
  r.post("/login",loginLimiter(),express.urlencoded({extended:false,limit:"16kb"}),(req,res)=>{const password=String((req.body as Record<string,unknown>)?.password??"");if(!safeEqual(password,env.ADMIN_PASSWORD!)){res.status(401).type("html").send(loginPage("Senha administrativa incorreta."));return;}setAdminCookie(res,makeAdminToken());res.redirect(303,"/admin");});
  r.get("/",requireAdmin,(req,res)=>{const claims=(req as Request & {adminClaims:AdminClaims}).adminClaims,notice=typeof req.query.notice==="string"?req.query.notice.slice(0,160):undefined;res.type("html").send(dashboardPage(claims,notice));});
  r.use(requireAdmin); r.use(express.urlencoded({extended:false,limit:"16kb"}));
  r.post("/logout",requireCsrf,(_req,res)=>{clearAdminCookie(res);res.redirect(303,"/admin/login");});
  r.post("/revoke-all",requireCsrf,(req,res)=>{const count=revokeAllClients();adminAudit(req,"admin.revoke_all_clients");res.redirect(303,`/admin?notice=${encodeURIComponent(`${count} cliente(s) revogado(s), incluindo todas as sessões.`)}`);});
  r.post("/clients/:clientId/revoke",requireCsrf,(req,res)=>{const ok=revokeClient(req.params.clientId);adminAudit(req,"admin.revoke_client",`client:${req.params.clientId}`,ok?"ok":"denied",ok?undefined:"CLIENT_NOT_FOUND");res.redirect(303,`/admin?notice=${encodeURIComponent(ok?"Cliente revogado imediatamente.":"Cliente não encontrado.")}`);});
  r.post("/sessions/:sessionId/revoke",requireCsrf,(req,res)=>{const ok=revokeSession(req.params.sessionId);adminAudit(req,"admin.revoke_session",`session:${req.params.sessionId}`,ok?"ok":"denied",ok?undefined:"SESSION_NOT_FOUND");res.redirect(303,`/admin?notice=${encodeURIComponent(ok?"Sessão revogada imediatamente.":"Sessão não encontrada.")}`);});
  r.post("/targets/:targetId/revoke",requireCsrf,(req,res)=>{const t=getTarget(req.params.targetId);if(t){setTargetEnabled(t.id,false,"revogado no console administrativo");closeTargetPool(t.id);}adminAudit(req,"admin.revoke_target",req.params.targetId,t?"ok":"denied",t?undefined:"TARGET_NOT_FOUND");res.redirect(303,`/admin?notice=${encodeURIComponent(t?"Device revogado. Novas operações estão bloqueadas.":"Device não encontrado.")}`);});
  r.post("/targets/:targetId/enable",requireCsrf,(req,res)=>{const t=getTarget(req.params.targetId);if(t)setTargetEnabled(t.id,true,"habilitado no console administrativo");adminAudit(req,"admin.enable_target",req.params.targetId,t?"ok":"denied",t?undefined:"TARGET_NOT_FOUND");res.redirect(303,`/admin?notice=${encodeURIComponent(t?"Device habilitado.":"Device não encontrado.")}`);});
  r.post("/targets/:targetId/check",requireCsrf,async(req,res)=>{const t=getTarget(req.params.targetId);if(!t||!effectiveTargetEnabled(req.params.targetId,t?.enabled??false)){res.redirect(303,`/admin?notice=${encodeURIComponent("Device inexistente ou revogado.")}`);return;}try{const x=await getTransport(t).exec(["hostname"]),ok=x.code===0&&x.stdout.trim().length>0;recordTargetProbe(t.id,ok,ok?undefined:`exit_${String(x.code)}`);res.redirect(303,`/admin?notice=${encodeURIComponent(ok?`Device ${t.id} respondeu ao probe.`:`Device ${t.id} retornou erro.`)}`);}catch(err){recordTargetProbe(t.id,false,err instanceof Error?err.name:"probe_error");res.redirect(303,`/admin?notice=${encodeURIComponent(`Probe de ${t.id} falhou.`)}`);}});
  return r;
}