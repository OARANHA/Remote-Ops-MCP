import crypto from "node:crypto";
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { env, validateAuthEnv } from "./lib/env.js";
import { loadRegistry, targetCount, targetIds } from "./config/targets.js";
import { oauthRouter, requireBearer } from "./auth/oauth.js";
import { handleMcpRequest } from "./server/mcp.js";
import { closeAllPools, startIdleSweeper } from "./ssh/pool.js";
import { initAuditFile } from "./audit/audit.js";
import { initStateStore } from "./state/store.js";
import { adminRouter } from "./admin/router.js";
import { agentRouter } from "./agent/router.js";
import { attachAgentGateway } from "./agent/gateway.js";

/**
 * Remote Ops MCP — entrypoint HTTP.
 *   GET  /                    -> página de status simples
 *   GET  /healthz /readyz     -> probes
 *   POST /mcp                 -> endpoint MCP (Streamable HTTP, stateless)
 *   OAuth: /.well-known/*, /register, /authorize, /authorize/submit, /token
 */

// ---------- fail fast ----------
validateAuthEnv();
try {
  loadRegistry();
} catch (e) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: (e as Error).message }));
  process.exit(1);
}
initStateStore();
initAuditFile();

const VERSION = "2.0.0-dev";
const startedAt = Date.now();

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// request id + structured log
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "http",
        request_id: requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        ip: req.ip,
      })
    );
  });
  next();
});

function rateLimit(maxPerMin: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= maxPerMin) {
      res.status(429).json({ error: "rate_limited", error_description: "muitas requisições; tente novamente em instantes" });
      return;
    }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 10_000) hits.clear();
    next();
  };
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Remote Ops MCP</title>
<style>body{background:#09090b;color:#e4e4e7;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{border:1px solid #27272a;border-radius:16px;padding:32px;max-width:520px}h1{font-size:20px;margin:0 0 8px}.ok{color:#34d399;font-weight:600}code{color:#34d399}li{margin:4px 0;color:#a1a1aa}</style>
</head><body><div class="card"><h1>Remote Ops MCP <span style="color:#71717a">v${VERSION}</span></h1><p class="ok">● operacional</p><p style="color:#a1a1aa">Endpoint MCP: <code>/mcp</code> (Streamable HTTP, stateless)<br>Auth: <code>${env.AUTH_MODE}</code>${env.MOCK_MODE === "1" ? " · <b>modo ensaio (MOCK)</b>" : ""}</p><ul><li><code>GET /healthz</code></li><li><code>GET /readyz</code></li><li><code>POST /mcp</code></li>${env.AUTH_MODE === "oauth" ? '<li><a style="color:#60a5fa" href="/admin">Admin console</a></li>' : ""}<li>targets configurados: <code>${targetCount()}</code></li></ul></div></body></html>`);
});
app.get("/healthz", (_req, res) => { res.json({ status: "ok", service: "remote-ops-mcp", version: VERSION }); });
app.get("/readyz", (_req, res) => { res.json({ status: "ready", targets: targetCount(), auth: env.AUTH_MODE, mock: env.MOCK_MODE === "1", uptime_s: Math.round((Date.now() - startedAt) / 1000) }); });

if (env.AUTH_MODE === "oauth") { app.use(oauthRouter()); app.use("/admin", adminRouter()); }
app.use("/agent", rateLimit(Math.max(30, Math.floor(env.RATE_LIMIT_PER_MIN / 2))), express.json({ limit: "64kb" }), agentRouter());

const mcpMiddleware = [rateLimit(env.RATE_LIMIT_PER_MIN), ...(env.AUTH_MODE === "oauth" ? [requireBearer] : []), express.json({ limit: "1mb" })];
app.post("/mcp", ...mcpMiddleware, (req, res) => {
  void handleMcpRequest(req, res).catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "mcp_handler_error", error: (err as Error).message }));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed", detail: "use POST /mcp (Streamable HTTP)" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

app.use((_req: Request, res: Response) => { res.status(404).json({ error: "not_found" }); });
app.use(((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.parse.failed") { res.status(400).json({ error: "invalid_json" }); return; }
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "unhandled", error: err.message }));
  res.status(500).json({ error: "internal" });
}) as express.ErrorRequestHandler);

const server = http.createServer(app);
attachAgentGateway(server);
server.listen(env.PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "remote-ops-mcp ready", version: VERSION, port: env.PORT, auth_mode: env.AUTH_MODE, mock_mode: env.MOCK_MODE === "1", targets: targetIds(), public_base_url: env.PUBLIC_BASE_URL }));
});
function shutdown(signal: string): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "shutdown", signal }));
  server.close(() => process.exit(0)); closeAllPools(); setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
startIdleSweeper();