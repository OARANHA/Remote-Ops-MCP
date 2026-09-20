import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { authenticateDeviceToken, touchDeviceHeartbeat } from "../state/store.js";

interface LiveConnection {
  deviceId: string;
  token: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
}

const live = new Map<string, LiveConnection>();

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

function safeJson(data: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function attachAgentGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
      if (previous && previous.ws.readyState === WebSocket.OPEN) {
        previous.ws.close(4001, "superseded");
      }
      const conn: LiveConnection = {
        deviceId: device.device_id,
        token,
        ws,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      live.set(device.device_id, conn);
      touchDeviceHeartbeat(device.device_id, { agent_version: device.agent_version, capabilities: device.capabilities });

      ws.send(JSON.stringify({
        type: "welcome",
        protocol: 1,
        device_id: device.device_id,
        server_time: new Date().toISOString(),
        heartbeat_interval_seconds: 30,
      }));

      ws.on("message", (data) => {
        const current = authenticateDeviceToken(token);
        if (!current) {
          ws.close(4003, "revoked");
          return;
        }
        const msg = safeJson(data);
        if (!msg) {
          ws.close(4002, "invalid_json");
          return;
        }
        const type = String(msg.type ?? "");
        if (type === "hello" || type === "heartbeat") {
          const agentVersion = typeof msg.agent_version === "string" ? msg.agent_version.slice(0, 40) : undefined;
          const caps = Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === "string").slice(0, 64) : undefined;
          touchDeviceHeartbeat(device.device_id, { agent_version: agentVersion, capabilities: caps });
          conn.lastSeenAt = Date.now();
          ws.send(JSON.stringify({ type: "heartbeat_ack", server_time: new Date().toISOString() }));
          return;
        }
        ws.send(JSON.stringify({ type: "error", code: "unsupported_message_type" }));
      });

      ws.on("close", () => {
        if (live.get(device.device_id)?.ws === ws) live.delete(device.device_id);
      });
    });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of live.values()) {
      if (!authenticateDeviceToken(conn.token)) {
        conn.ws.close(4003, "revoked");
        continue;
      }
      if (now - conn.lastSeenAt > 90_000) conn.ws.close(4000, "heartbeat_timeout");
      else if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }, 30_000);
  sweep.unref();
}

export function agentConnectionStatus(deviceId: string): { online: boolean; connected_at?: number; last_seen_at?: number } {
  const c = live.get(deviceId);
  return c && c.ws.readyState === WebSocket.OPEN
    ? { online: true, connected_at: c.connectedAt, last_seen_at: c.lastSeenAt }
    : { online: false };
}

export function disconnectAgentDevice(deviceId: string): void {
  const c = live.get(deviceId);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.close(4003, "revoked");
  live.delete(deviceId);
}