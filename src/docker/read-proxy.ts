import http, { type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 2375);
const SOCKET = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const MAX_BYTES = Math.min(Math.max(Number(process.env.MAX_PROXY_BYTES ?? 2 * 1024 * 1024), 64 * 1024), 8 * 1024 * 1024);
const allowed = new Set((process.env.ALLOWED_DOCKER_CONTAINERS ?? "").split(",").map((x) => x.trim()).filter(Boolean));

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("invalid PORT");
if (allowed.size === 0) throw new Error("ALLOWED_DOCKER_CONTAINERS must not be empty");

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": typeof body === "string" ? Buffer.byteLength(body) : body.length });
  res.end(body);
}
function jsonError(res: ServerResponse, status: number, code: string): void { send(res, status, JSON.stringify({ error: code })); }
function stripApiVersion(pathname: string): string { return pathname.replace(/^\/v\d+(?:\.\d+)?/, "") || "/"; }
function cleanContainerRef(ref: string): string | null {
  try { ref = decodeURIComponent(ref); } catch { return null; }
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref) ? ref : null;
}
async function resolveAllowedContainerRef(rawRef: string): Promise<string | null> {
  const ref = cleanContainerRef(rawRef);
  if (!ref) return null;
  if (allowed.has(ref)) return ref;
  if (!/^[a-f0-9]{12,64}$/i.test(ref)) return null;
  const u = await upstream("/containers/json?all=1");
  if (u.status !== 200) return null;
  let items: unknown;
  try { items = JSON.parse(u.body.toString("utf8")); } catch { return null; }
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const c = item as { Id?: unknown; Names?: unknown };
    const id = typeof c.Id === "string" ? c.Id : "";
    const names = Array.isArray(c.Names) ? c.Names : [];
    if ((id === ref || id.startsWith(ref)) && names.some((n) => typeof n === "string" && allowed.has(n.replace(/^\//, "")))) return ref;
  }
  return null;
}
function allowedQuery(url: URL, keys: Set<string>): boolean {
  for (const key of url.searchParams.keys()) if (!keys.has(key)) return false;
  return true;
}
function upstream(reqPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: SOCKET, path: reqPath, method: "GET", headers: { host: "docker" } }, (u) => {
      const chunks: Buffer[] = []; let total = 0;
      u.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) { r.destroy(new Error("upstream_response_too_large")); return; }
        chunks.push(chunk);
      });
      u.on("end", () => resolve({ status: u.statusCode ?? 502, headers: u.headers, body: Buffer.concat(chunks) }));
    });
    r.setTimeout(10000, () => r.destroy(new Error("upstream_timeout")));
    r.on("error", reject); r.end();
  });
}
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return jsonError(res, 405, "method_not_allowed");
  const raw = new URL(req.url ?? "/", "http://localhost");
  const path = stripApiVersion(raw.pathname);
  if (path === "/healthz") return send(res, 200, JSON.stringify({ status: "ok", allowed_containers: allowed.size }));
  if (path === "/_ping") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await upstream("/_ping");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "text/plain"));
  }
  if (path === "/version") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await upstream("/version");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
  }
  if (path === "/containers/json") {
    if (!allowedQuery(raw, new Set(["all", "limit", "size", "filters"]))) return jsonError(res, 400, "query_not_allowed");
    const q = new URLSearchParams();
    q.set("all", raw.searchParams.get("all") === "1" ? "1" : "0");
    if (raw.searchParams.has("limit")) q.set("limit", String(Math.min(Math.max(Number(raw.searchParams.get("limit")) || 0, 0), 100)));
    if (raw.searchParams.has("size")) q.set("size", raw.searchParams.get("size") === "1" ? "1" : "0");
    const u = await upstream("/containers/json?" + q.toString());
    if (u.status !== 200) return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
    let items: unknown;
    try { items = JSON.parse(u.body.toString("utf8")); } catch { return jsonError(res, 502, "invalid_upstream_json"); }
    if (!Array.isArray(items)) return jsonError(res, 502, "invalid_upstream_shape");
    const filtered = items.filter((item) => {
      const names = (item as { Names?: unknown }).Names;
      return Array.isArray(names) && names.some((n) => typeof n === "string" && allowed.has(n.replace(/^\//, "")));
    });
    return send(res, 200, JSON.stringify(filtered));
  }
  const m = /^\/containers\/([^/]+)\/(json|logs)$/.exec(path);
  if (!m) return jsonError(res, 404, "not_allowed");
  const rawRef = m[1], action = m[2];
  const ref = await resolveAllowedContainerRef(rawRef);
  if (!ref) return jsonError(res, 403, "container_not_allowed");
  if (action === "json") {
    if (raw.search) return jsonError(res, 400, "query_not_allowed");
    const u = await upstream("/containers/" + encodeURIComponent(ref) + "/json");
    return send(res, u.status, u.body.toString("utf8"), String(u.headers["content-type"] ?? "application/json"));
  }
  if (!allowedQuery(raw, new Set(["stdout", "stderr", "timestamps", "tail", "since", "until"]))) return jsonError(res, 400, "query_not_allowed");
  const q = new URLSearchParams();
  q.set("stdout", raw.searchParams.get("stdout") === "0" ? "0" : "1");
  q.set("stderr", raw.searchParams.get("stderr") === "0" ? "0" : "1");
  q.set("timestamps", raw.searchParams.get("timestamps") === "1" ? "1" : "0");
  q.set("tail", String(Math.min(Math.max(Number(raw.searchParams.get("tail") ?? "100") || 100, 1), 500)));
  for (const k of ["since", "until"]) {
    const v = raw.searchParams.get(k);
    if (v && /^\d+(?:\.\d+)?$/.test(v)) q.set(k, v);
  }
  const u = await upstream("/containers/" + encodeURIComponent(ref) + "/logs?" + q.toString());
  return send(res, u.status, u.body, String(u.headers["content-type"] ?? "application/octet-stream"));
}
const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "docker_read_proxy_error", error: err instanceof Error ? err.message : String(err) }));
    if (!res.headersSent) jsonError(res, 502, "upstream_error"); else res.end();
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "docker-read-proxy ready", port: PORT, allowed_containers: [...allowed] }));
});