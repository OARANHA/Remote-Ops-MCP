import crypto from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { authenticateDeviceToken, touchDeviceHeartbeat } from "../state/store.js";
import type { ExecOptions, ExecResult } from "../ssh/pool.js";
import type { AgentOperation } from "./operations.js";

interface LiveConnection {
  deviceId: string;
  token: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
}
interface Pending {
  deviceId: string;
  resolve: (value: ExecResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

const live = new Map<string, LiveConnection>();
const pending = new Map<string, Pending>();

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}
function safeJson(data: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function rejectPendingForDevice(deviceId: string, reason: string): void {
  for (const [id,p] of pending) {
    if (p.deviceId !== deviceId) continue;
    clearTimeout(p.timer); pending.delete(id); p.reject(new Error(reason));
  }
}

export function attachAgentGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch {}
    if (pathname !== "/agent/connect") return;

    const token = bearer(req);
    const device = token ? authenticateDeviceToken(token) : undefined;
    if (!token || !device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = live.get(device.device_id);
      if (previous && previous.ws.readyState === WebSocket.OPEN) previous.ws.close(4001, "superseded");
      const conn: LiveConnection = { deviceId: device.device_id, token, ws, connectedAt: Date.now(), lastSeenAt: Date.now() };
      live.set(device.device_id, conn);
      touchDeviceHeartbeat(device.device_id, { agent_version: device.agent_version, capabilities: device.capabilities });

      ws.send(JSON.stringify({ type: "welcome", protocol: 1, device_id: device.device_id, server_time: new Date().toISOString(), heartbeat_interval_seconds: 30 }));

      ws.on("message", (data) => {
        const current = authenticateDeviceToken(token);
        if (!current) { ws.close(4003, "revoked"); return; }
        const msg = safeJson(data);
        if (!msg) { ws.close(4002, "invalid_json"); return; }
        const type = String(msg.type ?? "");
        if (type === "hello" || type === "heartbeat") {
          const agentVersion = typeof msg.agent_version === "string" ? msg.agent_version.slice(0, 40) : undefined;
          const caps = Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === "string").slice(0, 64) : undefined;
          touchDeviceHeartbeat(device.device_id, { agent_version: agentVersion, capabilities: caps });
          conn.lastSeenAt = Date.now();
          ws.send(JSON.stringify({ type: "heartbeat_ack", server_time: new Date().toISOString() }));
          return;
        }
        if (type === "execute_result") {
          const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
          const p = pending.get(requestId);
          if (!p || p.deviceId !== device.device_id) return;
          clearTimeout(p.timer); pending.delete(requestId); conn.lastSeenAt = Date.now();
          const raw = msg.result;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) { p.reject(new Error("invalid_agent_result")); return; }
          const r = raw as Record<string, unknown>;
          p.resolve({
            code: typeof r.code === "number" || r.code === null ? r.code as number|null : 1,
            stdout: typeof r.stdout === "string" ? r.stdout : "",
            stderr: typeof r.stderr === "string" ? r.stderr : "",
            durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
            truncated: r.truncated === true,
            timedOut: r.timedOut === true,
          });
          return;
        }
        ws.send(JSON.stringify({ type: "error", code: "unsupported_message_type" }));
      });

      ws.on("close", () => {
        if (live.get(device.device_id)?.ws === ws) live.delete(device.device_id);
        rejectPendingForDevice(device.device_id, "agent_disconnected");
      });
    });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of live.values()) {
      if (!authenticateDeviceToken(conn.token)) { conn.ws.close(4003, "revoked"); continue; }
      if (now - conn.lastSeenAt > 90_000) conn.ws.close(4000, "heartbeat_timeout");
      else if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }, 30_000);
  sweep.unref();
}

export async function dispatchAgentOperation(deviceId: string, operation: AgentOperation, opts?: ExecOptions): Promise<ExecResult> {
  const conn = live.get(deviceId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) throw new Error("agent_offline");
  if (!authenticateDeviceToken(conn.token)) throw new Error("agent_revoked");
  const requestId = crypto.randomUUID();
  const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 15_000, 2_000), 120_000);
  const maxBytes = Math.min(Math.max(opts?.maxBytes ?? 262_144, 4096), 4_194_304);
  return await new Promise<ExecResult>((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error("agent_request_timeout"));},timeoutMs+1000);
    pending.set(requestId,{deviceId,resolve,reject,timer});
    conn.ws.send(JSON.stringify({type:"execute_request",protocol:1,request_id:requestId,operation,limits:{timeout_ms:timeoutMs,max_bytes:maxBytes}}),(err)=>{
      if(err){clearTimeout(timer);pending.delete(requestId);reject(err);}
    });
  });
}

export function agentConnectionStatus(deviceId: string): { online: boolean; connected_at?: number; last_seen_at?: number } {
  const c = live.get(deviceId);
  return c && c.ws.readyState === WebSocket.OPEN ? { online: true, connected_at: c.connectedAt, last_seen_at: c.lastSeenAt } : { online: false };
}
export function disconnectAgentDevice(deviceId: string): void {
  const c = live.get(deviceId);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close(4003, "revoked");
  live.delete(deviceId); rejectPendingForDevice(deviceId,"agent_revoked");
}