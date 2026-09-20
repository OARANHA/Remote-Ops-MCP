import crypto from "node:crypto";
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { env } from "../lib/env.js";
import {
  consumeAuthCode,
  createSession,
  findSessionByRefreshToken,
  getClient,
  putAuthCode,
  registerClient,
  rotateRefreshToken,
  sessionIsActive,
  sha256,
  touchSession,
  type StoredClient,
} from "../state/store.js";

const READ_SCOPE = "mcp:read";
const OFFLINE_SCOPE = "offline_access";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 600;
const MCP_RESOURCE = `${env.PUBLIC_BASE_URL}/mcp`;

function b64uJson(obj: unknown): string { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url"); }

export function signAccessToken(payload: Record<string, unknown>, resource = MCP_RESOURCE): string {
  const header = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson({ ...payload, iss: env.PUBLIC_BASE_URL, aud: resource, scope: `${READ_SCOPE} ${OFFLINE_SCOPE}` });
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", env.AUTH_SECRET!).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyAccessToken(token: string): Record<string, unknown> | null {
  const parts = token.split("."); if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", env.AUTH_SECRET!).update(data).digest();
  let given: Buffer;
  try { given = Buffer.from(parts[2], "base64url"); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || now >= payload.exp) return null;
    if (typeof payload.iat !== "number" || payload.iat > now + 60) return null;
    if (payload.iss !== env.PUBLIC_BASE_URL || payload.aud !== MCP_RESOURCE) return null;
    const cid = typeof payload.cid === "string" ? payload.cid : "";
    const sid = typeof payload.sid === "string" ? payload.sid : "";
    if (!cid || !sid || !sessionIsActive(sid, cid)) return null;
    return payload;
  } catch { return null; }
}

function pkceChallengeS256(verifier: string): string { return crypto.createHash("sha256").update(verifier, "utf8").digest("base64url"); }
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}
function randomId(prefix: string, bytes = 24): string { return `${prefix}-${crypto.randomBytes(bytes).toString("base64url")}`; }
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function validRedirect(client: StoredClient, uri: string): boolean { return !!uri && client.redirect_uris.includes(uri) && validRedirectUri(uri); }
function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch { return false; }
}
function normalizeResource(raw: unknown): string {
  const resource = typeof raw === "string" && raw.trim() ? raw.trim() : MCP_RESOURCE;
  if (resource !== MCP_RESOURCE) throw new Error("invalid_resource");
  return resource;
}
function normalizeScope(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return `${READ_SCOPE} ${OFFLINE_SCOPE}`;
  const requested = new Set(raw.trim().split(/\s+/));
  if (!requested.has(READ_SCOPE)) throw new Error("missing_read_scope");
  for (const s of requested) if (s !== READ_SCOPE && s !== OFFLINE_SCOPE) throw new Error("unsupported_scope");
  return `${READ_SCOPE} ${OFFLINE_SCOPE}`;
}

function loginPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields).filter(([k]) => k !== "password").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n      ");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Ops MCP — Autorização</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'"><style>:root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}.card{width:100%;max-width:400px;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35)}h1{font-size:19px;margin-bottom:7px;color:#fafafa}p{font-size:13px;line-height:1.5;color:#a1a1aa;margin-bottom:16px}.err{background:#450a0a;border:1px solid #7f1d1d;color:#fca5a5;padding:9px 12px;border-radius:8px;font-size:12px;margin-bottom:12px}input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #3f3f46;background:#09090b;color:#e4e4e7;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;border-radius:10px;border:0;background:#059669;color:#fff;font-size:14px;font-weight:650;cursor:pointer}.hint{margin-top:14px;font-size:11px;color:#71717a;text-align:center}</style></head><body><main class="card"><h1>Remote Ops MCP</h1><p>Autorize este cliente a usar as capacidades read-only do Remote Ops.</p>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}<form method="POST" action="/authorize/submit">${hidden}<input type="password" name="password" required autofocus autocomplete="current-password" placeholder="Senha de autorização"><button type="submit">Autorizar conexão</button></form><p class="hint">Se você não iniciou esta conexão, feche a janela.</p></main></body></html>`;
}

function authLimiter(max: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown", now = Date.now();
    const active = (hits.get(key) ?? []).filter((x) => now - x < windowMs);
    if (active.length >= max) { res.status(429).json({ error: "slow_down", error_description: "muitas tentativas; aguarde e tente novamente" }); return; }
    active.push(now); hits.set(key, active); if (hits.size > 5_000) hits.clear(); next();
  };
}

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return bearerUnauthorized(res);
  const payload = verifyAccessToken(m[1].trim()); if (!payload) return bearerUnauthorized(res);
  const cid = String(payload.cid ?? "unknown"), sid = String(payload.sid ?? "unknown"); touchSession(sid);
  const typed = req as Request & { actor?: string; oauthClientId?: string; oauthSessionId?: string };
  typed.actor = `oauth:${cid}:${sid.slice(0, 12)}`; typed.oauthClientId = cid; typed.oauthSessionId = sid; next();
}
export function bearerUnauthorized(res: Response): void {
  res.status(401).set("WWW-Authenticate", `Bearer realm="remote-ops-mcp", resource_metadata="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", scope="${READ_SCOPE}"`).json({ error: "unauthorized", error_description: "token ausente, expirado, revogado ou inválido" });
}

export function oauthRouter(): Router {
  const r = Router(), tokenLimiter = authLimiter(60), authorizeLimiter = authLimiter(12, 5 * 60_000);
  r.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource: `${env.PUBLIC_BASE_URL}/mcp`, authorization_servers: [env.PUBLIC_BASE_URL], scopes_supported: [READ_SCOPE], bearer_methods_supported: ["header"] }));
  const authorizationMetadata = { issuer: env.PUBLIC_BASE_URL, authorization_response_iss_parameter_supported: true, authorization_endpoint: `${env.PUBLIC_BASE_URL}/authorize`, token_endpoint: `${env.PUBLIC_BASE_URL}/token`, registration_endpoint: `${env.PUBLIC_BASE_URL}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: [READ_SCOPE, OFFLINE_SCOPE], service_documentation: `${env.PUBLIC_BASE_URL}/` };
  r.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authorizationMetadata));
  r.get("/.well-known/openid-configuration", (_req, res) => res.json(authorizationMetadata));

  r.post("/register", authLimiter(30), express.json({ limit: "64kb" }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>, redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 5) return void res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris deve conter 1-5 URIs" });
    const uris = redirectUris.map(String); if (uris.some((u) => !validRedirectUri(u))) return void res.status(400).json({ error: "invalid_redirect_uri", error_description: "use HTTPS; loopback HTTP é aceito apenas para desenvolvimento" });
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") return void res.status(400).json({ error: "invalid_client_metadata", error_description: "somente public clients são suportados" });
    const client: StoredClient = { client_id: randomId("ro"), client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined, redirect_uris: uris, created_at: Date.now() };
    if (!registerClient(client)) {
      res.status(429).json({ error: "temporarily_unavailable", error_description: "limite de clientes OAuth atingido; remova clientes antigos no console administrativo ou aguarde a expiração de registros pendentes" });
      return;
    }
    res.status(201).json({ client_id: client.client_id, client_id_issued_at: Math.floor(client.created_at / 1000), client_name: client.client_name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: `${READ_SCOPE} ${OFFLINE_SCOPE}` });
  });

  r.get("/authorize", (req, res) => {
    const fields = { response_type: String(req.query.response_type ?? ""), client_id: String(req.query.client_id ?? ""), redirect_uri: String(req.query.redirect_uri ?? ""), state: String(req.query.state ?? ""), code_challenge: String(req.query.code_challenge ?? ""), code_challenge_method: String(req.query.code_challenge_method ?? ""), scope: String(req.query.scope ?? `${READ_SCOPE} ${OFFLINE_SCOPE}`), resource: String(req.query.resource ?? MCP_RESOURCE) };
    const client = getClient(fields.client_id);
    if (fields.response_type !== "code" || !client || client.revoked_at || !validRedirect(client, fields.redirect_uri)) return void res.status(400).type("text/plain").send("Solicitação OAuth inválida.");
    if (fields.code_challenge_method !== "S256" || fields.code_challenge.length < 43) return void res.status(400).type("text/plain").send("PKCE S256 é obrigatório.");
    try { normalizeScope(fields.scope); normalizeResource(fields.resource); } catch { return void res.status(400).type("text/plain").send("Escopo ou resource OAuth inválido."); }
    res.type("html").send(loginPage(fields));
  });

  r.post("/authorize/submit", authorizeLimiter, express.urlencoded({ extended: false, limit: "32kb" }), (req, res) => {
    const body = req.body as Record<string, string>;
    const fields = { response_type: String(body.response_type ?? "code"), client_id: String(body.client_id ?? ""), redirect_uri: String(body.redirect_uri ?? ""), state: String(body.state ?? ""), code_challenge: String(body.code_challenge ?? ""), code_challenge_method: String(body.code_challenge_method ?? ""), scope: String(body.scope ?? `${READ_SCOPE} ${OFFLINE_SCOPE}`), resource: String(body.resource ?? MCP_RESOURCE) };
    const client = getClient(fields.client_id);
    if (!client || client.revoked_at || !validRedirect(client, fields.redirect_uri) || fields.code_challenge_method !== "S256" || fields.code_challenge.length < 43) return void res.status(400).type("text/plain").send("Solicitação OAuth inválida.");
    try { normalizeScope(fields.scope); normalizeResource(fields.resource); } catch { return void res.status(400).type("text/plain").send("Escopo ou resource OAuth inválido."); }
    if (!safeEqual(String(body.password ?? ""), env.MCP_PASSWORD!)) return void res.status(401).type("html").send(loginPage(fields, "Senha incorreta."));
    const code = randomId("code"); putAuthCode(code, { client_id: client.client_id, redirect_uri: fields.redirect_uri, challenge: fields.code_challenge, resource: fields.resource, expires_at: Date.now() + CODE_TTL_S * 1000 });
    const u = new URL(fields.redirect_uri); u.searchParams.set("code", code); u.searchParams.set("iss", env.PUBLIC_BASE_URL); if (fields.state) u.searchParams.set("state", fields.state); res.redirect(303, u.toString());
  });

  r.post("/token", tokenLimiter, express.urlencoded({ extended: false, limit: "32kb" }), (req, res) => {
    res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
    const body = req.body as Record<string, string>, grant = String(body.grant_type ?? ""), clientId = String(body.client_id ?? ""), client = getClient(clientId);
    if (!client || client.revoked_at) return void res.status(400).json({ error: "invalid_client" });
    if (grant === "authorization_code") {
      const code = consumeAuthCode(String(body.code ?? "")), verifier = String(body.code_verifier ?? ""), redirectUri = String(body.redirect_uri ?? "");
      let resource: string;
      try { resource = normalizeResource(body.resource ?? code?.resource ?? MCP_RESOURCE); } catch { return void res.status(400).json({ error: "invalid_target" }); }
      if (!code || code.client_id !== clientId || code.redirect_uri !== redirectUri || (code.resource ?? MCP_RESOURCE) !== resource || verifier.length < 43 || !safeEqual(pkceChallengeS256(verifier), code.challenge)) return void res.status(400).json({ error: "invalid_grant" });
      issueNewSession(res, clientId, resource); return;
    }
    if (grant === "refresh_token") {
      const session = findSessionByRefreshToken(String(body.refresh_token ?? "")), now = Date.now();
      if (!session || session.client_id !== clientId || session.revoked_at || session.refresh_expires_at < now) return void res.status(400).json({ error: "invalid_grant" });
      const nextRefresh = randomId("rt", 32), accessExpiresAt = now + ACCESS_TTL_S * 1000, refreshExpiresAt = now + REFRESH_TTL_S * 1000;
      if (!rotateRefreshToken(session.session_id, nextRefresh, refreshExpiresAt, accessExpiresAt, now)) return void res.status(400).json({ error: "invalid_grant" });
      let resource: string;
      try { resource = normalizeResource(body.resource ?? session.resource ?? MCP_RESOURCE); } catch { return void res.status(400).json({ error: "invalid_target" }); }
      if ((session.resource ?? MCP_RESOURCE) !== resource) return void res.status(400).json({ error: "invalid_target" });
      res.json(tokenResponse(clientId, session.session_id, nextRefresh, accessExpiresAt, resource)); return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });
  return r;
}

function tokenResponse(clientId: string, sessionId: string, refreshToken: string, accessExpiresAt: number, resource = MCP_RESOURCE) {
  const nowS = Math.floor(Date.now() / 1000);
  const accessToken = signAccessToken({ cid: clientId, sid: sessionId, sub: `mcp-session:${sessionId}`, jti: randomId("at", 16), iat: nowS, exp: Math.floor(accessExpiresAt / 1000) }, resource);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: `${READ_SCOPE} ${OFFLINE_SCOPE}` };
}
function issueNewSession(res: Response, clientId: string, resource = MCP_RESOURCE): void {
  const now = Date.now(), sessionId = randomId("sess", 24), refresh = randomId("rt", 32), accessExpiresAt = now + ACCESS_TTL_S * 1000;
  createSession({ session_id: sessionId, client_id: clientId, created_at: now, last_seen_at: now, access_expires_at: accessExpiresAt, refresh_hash: sha256(refresh), refresh_expires_at: now + REFRESH_TTL_S * 1000, resource });
  res.json(tokenResponse(clientId, sessionId, refresh, accessExpiresAt, resource));
}