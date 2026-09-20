import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";

export interface StoredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
  last_seen_at?: number;
  revoked_at?: number;
}

export interface StoredAuthCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  challenge: string;
  expires_at: number;
}

export interface StoredSession {
  session_id: string;
  client_id: string;
  created_at: number;
  last_seen_at: number;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  revoked_at?: number;
}

export interface TargetControl {
  enabled: boolean;
  updated_at: number;
  reason?: string;
}

export interface TargetActivity {
  last_seen_at: number;
  last_ok_at?: number;
  last_error_at?: number;
  last_tool?: string;
  last_result: "ok" | "denied" | "error";
  last_error_code?: string;
}

export interface UsageBucket {
  tool_calls: number;
  ok: number;
  denied: number;
  error: number;
}

interface PersistentState {
  version: 1;
  clients: Record<string, StoredClient>;
  auth_codes: Record<string, StoredAuthCode>;
  sessions: Record<string, StoredSession>;
  target_controls: Record<string, TargetControl>;
  target_activity: Record<string, TargetActivity>;
  usage_monthly: Record<string, UsageBucket>;
}

function emptyState(): PersistentState {
  return { version: 1, clients: {}, auth_codes: {}, sessions: {}, target_controls: {}, target_activity: {}, usage_monthly: {} };
}

let state: PersistentState | null = null;
const lastSessionTouch = new Map<string, number>();

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function ensureLoaded(): PersistentState {
  if (!state) initStateStore();
  return state!;
}

function normalize(raw: unknown): PersistentState {
  if (!raw || typeof raw !== "object") throw new Error("state store inválido: raiz não é objeto");
  const obj = raw as Partial<PersistentState>;
  if (obj.version !== 1) throw new Error(`state store inválido: versão ${String(obj.version)} não suportada`);
  return {
    version: 1,
    clients: obj.clients && typeof obj.clients === "object" ? obj.clients : {},
    auth_codes: obj.auth_codes && typeof obj.auth_codes === "object" ? obj.auth_codes : {},
    sessions: obj.sessions && typeof obj.sessions === "object" ? obj.sessions : {},
    target_controls: obj.target_controls && typeof obj.target_controls === "object" ? obj.target_controls : {},
    target_activity: obj.target_activity && typeof obj.target_activity === "object" ? obj.target_activity : {},
    usage_monthly: obj.usage_monthly && typeof obj.usage_monthly === "object" ? obj.usage_monthly : {},
  };
}

function persist(): void {
  const s = ensureLoaded();
  const file = env.STATE_FILE;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* mounted filesystems may reject chmod */ }
}

export function initStateStore(): void {
  if (state) return;
  try {
    state = normalize(JSON.parse(fs.readFileSync(env.STATE_FILE, "utf8")));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw new Error(`state store não pôde ser carregado de ${env.STATE_FILE}: ${e.message}`);
    state = emptyState();
    persist();
  }
  purgeState(false);
}

function prunePendingClients(now = Date.now()): boolean {
  const s = ensureLoaded();
  const ttl = env.OAUTH_PENDING_CLIENT_TTL_HOURS * 3600_000;
  const sessionClients = new Set(Object.values(s.sessions).map((session) => session.client_id));
  let changed = false;
  for (const [clientId, client] of Object.entries(s.clients)) {
    const neverActivated = !client.last_seen_at && !sessionClients.has(clientId);
    if (neverActivated && client.created_at + ttl < now) {
      delete s.clients[clientId];
      changed = true;
    }
  }
  return changed;
}

export function registerClient(client: StoredClient): boolean {
  const s = ensureLoaded();
  const pruned = prunePendingClients();
  if (Object.keys(s.clients).length >= env.OAUTH_MAX_CLIENTS) {
    if (pruned) persist();
    return false;
  }
  s.clients[client.client_id] = client;
  persist();
  return true;
}
export function getClient(clientId: string): StoredClient | undefined { return ensureLoaded().clients[clientId]; }
export function listClients(): StoredClient[] { return Object.values(ensureLoaded().clients).sort((a, b) => b.created_at - a.created_at); }

export function touchClient(clientId: string, now = Date.now()): void {
  const c = getClient(clientId);
  if (!c || c.revoked_at || (c.last_seen_at && now - c.last_seen_at < 60_000)) return;
  c.last_seen_at = now; persist();
}

export function revokeClient(clientId: string, now = Date.now()): boolean {
  const s = ensureLoaded(); const c = s.clients[clientId]; if (!c) return false;
  c.revoked_at = now;
  for (const session of Object.values(s.sessions)) if (session.client_id === clientId && !session.revoked_at) session.revoked_at = now;
  persist(); return true;
}

export function revokeAllClients(now = Date.now()): number {
  const s = ensureLoaded();
  let count = 0;
  for (const client of Object.values(s.clients)) {
    if (!client.revoked_at) {
      client.revoked_at = now;
      count++;
    }
  }
  for (const session of Object.values(s.sessions)) {
    if (!session.revoked_at) session.revoked_at = now;
  }
  persist();
  return count;
}

export function putAuthCode(rawCode: string, code: Omit<StoredAuthCode, "code_hash">): void {
  const hash = sha256(rawCode); ensureLoaded().auth_codes[hash] = { ...code, code_hash: hash }; persist();
}

export function consumeAuthCode(rawCode: string, now = Date.now()): StoredAuthCode | undefined {
  const s = ensureLoaded(); const hash = sha256(rawCode); const code = s.auth_codes[hash];
  if (!code) return undefined; delete s.auth_codes[hash]; persist();
  return code.expires_at < now ? undefined : code;
}

export function createSession(session: StoredSession): void { ensureLoaded().sessions[session.session_id] = session; persist(); }
export function getSession(sessionId: string): StoredSession | undefined { return ensureLoaded().sessions[sessionId]; }
export function listSessions(): StoredSession[] { return Object.values(ensureLoaded().sessions).sort((a, b) => b.last_seen_at - a.last_seen_at); }
export function findSessionByRefreshToken(rawRefresh: string): StoredSession | undefined {
  const hash = sha256(rawRefresh); return Object.values(ensureLoaded().sessions).find((s) => s.refresh_hash === hash);
}

export function rotateRefreshToken(sessionId: string, rawRefresh: string, refreshExpiresAt: number, accessExpiresAt: number, now = Date.now()): boolean {
  const session = getSession(sessionId); if (!session || session.revoked_at) return false;
  session.refresh_hash = sha256(rawRefresh); session.refresh_expires_at = refreshExpiresAt; session.access_expires_at = accessExpiresAt; session.last_seen_at = now;
  persist(); return true;
}

export function sessionIsActive(sessionId: string, clientId: string, now = Date.now()): boolean {
  const session = getSession(sessionId); if (!session || session.client_id !== clientId || session.revoked_at || session.refresh_expires_at < now) return false;
  const client = getClient(clientId); return !!client && !client.revoked_at;
}

export function touchSession(sessionId: string, now = Date.now()): void {
  const session = getSession(sessionId); if (!session || session.revoked_at) return;
  const last = lastSessionTouch.get(sessionId) ?? 0; if (now - last < 60_000) return;
  lastSessionTouch.set(sessionId, now); session.last_seen_at = now;
  const client = getClient(session.client_id); if (client && !client.revoked_at) client.last_seen_at = now;
  persist();
}

export function revokeSession(sessionId: string, now = Date.now()): boolean {
  const session = getSession(sessionId); if (!session) return false; if (!session.revoked_at) session.revoked_at = now; persist(); return true;
}

export function revokeAllSessions(now = Date.now()): number {
  let count = 0; for (const s of Object.values(ensureLoaded().sessions)) if (!s.revoked_at) { s.revoked_at = now; count++; }
  persist(); return count;
}

export function effectiveTargetEnabled(targetId: string, registryEnabled: boolean): boolean {
  if (!registryEnabled) return false; const control = ensureLoaded().target_controls[targetId]; return control ? control.enabled : true;
}
export function setTargetEnabled(targetId: string, enabled: boolean, reason?: string): void {
  ensureLoaded().target_controls[targetId] = { enabled, updated_at: Date.now(), reason: reason?.slice(0, 200) }; persist();
}
export function getTargetControl(targetId: string): TargetControl | undefined { return ensureLoaded().target_controls[targetId]; }
export function getTargetActivity(targetId: string): TargetActivity | undefined { return ensureLoaded().target_activity[targetId]; }

export function recordToolResult(input: { target?: string; tool: string; result: "ok" | "denied" | "error"; error_code?: string; ts?: number }): void {
  const s = ensureLoaded(); const now = input.ts ?? Date.now(); const month = new Date(now).toISOString().slice(0, 7);
  const bucket = s.usage_monthly[month] ?? { tool_calls: 0, ok: 0, denied: 0, error: 0 };
  bucket.tool_calls++; bucket[input.result]++; s.usage_monthly[month] = bucket;
  if (input.target) {
    const prev = s.target_activity[input.target];
    s.target_activity[input.target] = {
      last_seen_at: now,
      last_ok_at: input.result === "ok" ? now : prev?.last_ok_at,
      last_error_at: input.result === "error" ? now : prev?.last_error_at,
      last_tool: input.tool,
      last_result: input.result,
      last_error_code: input.error_code,
    };
  }
  persist();
}

export function recordTargetProbe(target: string, ok: boolean, errorCode?: string, now = Date.now()): void {
  const s = ensureLoaded(); const prev = s.target_activity[target];
  s.target_activity[target] = {
    last_seen_at: now,
    last_ok_at: ok ? now : prev?.last_ok_at,
    last_error_at: ok ? prev?.last_error_at : now,
    last_tool: "admin_probe",
    last_result: ok ? "ok" : "error",
    last_error_code: errorCode,
  };
  persist();
}

export function usageForMonth(month = new Date().toISOString().slice(0, 7)): UsageBucket {
  return ensureLoaded().usage_monthly[month] ?? { tool_calls: 0, ok: 0, denied: 0, error: 0 };
}

export function activeSessionCount(clientId?: string): number {
  const now = Date.now();
  return Object.values(ensureLoaded().sessions).filter((s) => {
    if (clientId && s.client_id !== clientId) return false;
    const c = getClient(s.client_id); return !s.revoked_at && s.refresh_expires_at >= now && !!c && !c.revoked_at;
  }).length;
}

export function purgeState(doPersist = true): void {
  const s = ensureLoaded(); const now = Date.now(); let changed = prunePendingClients(now);
  for (const [hash, code] of Object.entries(s.auth_codes)) if (code.expires_at < now) { delete s.auth_codes[hash]; changed = true; }
  const retention = 90 * 24 * 3600_000;
  for (const [sid, session] of Object.entries(s.sessions)) {
    const staleSince = session.revoked_at ?? session.refresh_expires_at;
    if (staleSince + retention < now) { delete s.sessions[sid]; changed = true; }
  }
  if (changed && doPersist) persist();
}

setInterval(() => purgeState(true), 15 * 60_000).unref();
