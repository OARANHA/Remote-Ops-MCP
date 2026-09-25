export type PaperclipSemanticOperation =
  | "task-drain-status"
  | "task-drain-start"
  | "task-drain-stop"
  | "tool-policies-list"
  | "tool-connection-activity-safe"
  | "tool-policy-test"
  | "tool-policy-create"
  | "tool-policy-delete";

export const PAPERCLIP_SEMANTIC_CONTAINER = process.env.PAPERCLIP_SEMANTIC_CONTAINER?.trim() || "wandora-paperclip";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_payload");
  return value as Record<string, unknown>;
}

function requireGuid(value: unknown, label: string): string {
  const s = String(value ?? "");
  if (!GUID.test(s)) throw new Error("invalid_" + label);
  return s;
}

function requireToolName(value: unknown, label: string): string {
  const s = String(value ?? "").trim();
  if (!s || s.length > 240 || !/^[A-Za-z0-9_.:-]+$/.test(s)) throw new Error("invalid_" + label);
  return s;
}

function normalizeSelectors(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  const allowed = new Set(["agentId","connectionId","catalogEntryId","toolName","toolNames"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error("unsupported_selector");
  const out: Record<string, unknown> = {};
  if (input.agentId != null) out.agentId = requireGuid(input.agentId, "selector_agent_id");
  if (input.connectionId != null) out.connectionId = requireGuid(input.connectionId, "selector_connection_id");
  if (input.catalogEntryId != null) out.catalogEntryId = requireGuid(input.catalogEntryId, "selector_catalog_entry_id");
  if (input.toolName != null) out.toolName = requireToolName(input.toolName, "selector_tool_name");
  if (input.toolNames != null) {
    if (!Array.isArray(input.toolNames) || input.toolNames.length < 1 || input.toolNames.length > 32) throw new Error("invalid_selector_tool_names");
    out.toolNames = input.toolNames.map((x) => requireToolName(x, "selector_tool_name"));
  }
  if (Object.keys(out).length < 1) throw new Error("empty_selectors");
  return out;
}

export function normalizePaperclipSemanticPayload(op: PaperclipSemanticOperation, value: unknown): Record<string, unknown> {
  const payload = asRecord(value ?? {});
  if (op === "task-drain-status" || op === "task-drain-stop") return {};
  if (op === "task-drain-start") {
    const ttlMs = Number(payload.ttlMs);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000) throw new Error("invalid_ttl_ms");
    return { ttlMs };
  }
  if (op === "tool-connection-activity-safe") {
    const companyId = requireGuid(payload.companyId, "company_id");
    const connectionId = requireGuid(payload.connectionId, "connection_id");
    const limit = Number(payload.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_activity_limit");
    const runId = requireGuid(payload.runId, "run_id");
    const toolName = requireToolName(payload.toolName, "tool_name");
    return { companyId, connectionId, limit, runId, toolName };
  }
  const companyId = requireGuid(payload.companyId, "company_id");
  if (op === "tool-policies-list") return { companyId };
  if (op === "tool-policy-delete") {
    const policyId = requireGuid(payload.policyId, "policy_id");
    const expectedName = String(payload.expectedName ?? "").trim();
    if (!expectedName || expectedName.length > 160) throw new Error("invalid_expected_name");
    return { companyId, policyId, expectedName };
  }
  if (op === "tool-policy-create") {
    const name = String(payload.name ?? "").trim();
    if (!name || name.length > 160) throw new Error("invalid_policy_name");
    const description = payload.description == null ? null : String(payload.description);
    if (description != null && description.length > 4000) throw new Error("invalid_policy_description");
    const policyType = String(payload.policyType ?? "");
    if (policyType !== "block" && policyType !== "rate_limit") throw new Error("unsupported_policy_type");
    const priority = Number(payload.priority ?? 100);
    if (!Number.isInteger(priority) || priority < 0 || priority > 10000) throw new Error("invalid_policy_priority");
    const selectors = normalizeSelectors(payload.selectors);
    let config: Record<string, unknown> | null = null;
    if (policyType === "rate_limit") {
      const c = asRecord(payload.config);
      const limit = Number(c.limit);
      const windowSeconds = Number(c.windowSeconds);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid_rate_limit");
      if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) throw new Error("invalid_window_seconds");
      if (!Array.isArray(c.keyBy) || c.keyBy.length < 1 || c.keyBy.length > 4) throw new Error("invalid_key_by");
      const keyBy = c.keyBy.map((x) => String(x));
      if (keyBy.some((x) => !["agent","tool","connection"].includes(x))) throw new Error("invalid_key_by");
      config = { limit, windowSeconds, keyBy };
    } else if (payload.config != null) {
      throw new Error("block_config_not_allowed");
    }
    return { companyId, name, description, policyType, priority, enabled: true, selectors, conditions: null, config };
  }

  const actor = asRecord(payload.actor);
  const request = asRecord(payload.request);
  if (!["agent", "user", "system", "plugin"].includes(String(actor.actorType ?? ""))) throw new Error("invalid_actor_type");
  const actorId = String(actor.actorId ?? "").trim();
  if (!actorId || actorId.length > 240) throw new Error("invalid_actor_id");
  const toolName = String(request.toolName ?? "").trim();
  if (!toolName || toolName.length > 240) throw new Error("invalid_tool_name");
  const runContext = payload.runContext == null ? null : asRecord(payload.runContext);
  return {
    companyId,
    actor,
    runContext,
    request,
    consumeRateLimit: false,
    writeAuditEvent: false,
  };
}

export const PAPERCLIP_SEMANTIC_SCRIPT = String.raw`
import { resolveCommandContext } from "/app/cli/src/commands/client/common.ts";

process.env.PAPERCLIP_AUTH_STORE = "/paperclip/operator-cli/activation-v1/auth.json";
process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
process.env.PAPERCLIP_NO_BROWSER = "1";

const op = process.argv[1] ?? "";
const encoded = process.argv[2] ?? "";
const input = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) : {};
const ctx = resolveCommandContext({ apiBase: "http://127.0.0.1:3100", json: true });
if (ctx.authSource !== "stored_board") throw new Error("stored_board_credential_required");

let result;
if (op === "task-drain-status") {
  result = await ctx.api.get("/api/instance/task-drain");
} else if (op === "task-drain-start") {
  result = await ctx.api.post("/api/instance/task-drain", { ttlMs: input.ttlMs });
} else if (op === "task-drain-stop") {
  result = await ctx.api.delete("/api/instance/task-drain");
} else if (op === "tool-policies-list") {
  const companyId = encodeURIComponent(String(input.companyId ?? ""));
  result = await ctx.api.get("/api/companies/" + companyId + "/tools/policies");
} else if (op === "tool-connection-activity-safe") {
  const connectionId = encodeURIComponent(String(input.connectionId ?? ""));
  const limit = Number(input.limit ?? 20);
  const connection = await ctx.api.get("/api/tool-connections/" + connectionId);
  if (!connection || connection.companyId !== input.companyId) throw new Error("connection_company_mismatch");
  const raw = await ctx.api.get("/api/tool-connections/" + connectionId + "/activity?limit=" + encodeURIComponent(String(limit)));
  const rows = Array.isArray(raw?.events) ? raw.events : [];
  const safeString = (value, max = 240) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  const safeInt = (value) => Number.isInteger(value) ? value : null;
  const extractDiagnostic = (value) => {
    const summary = value && typeof value === "object" && !Array.isArray(value) ? value.summary : value;
    if (typeof summary !== "string" || summary.length < 2 || summary.length > 65536) return { code: null, reason: null, shape: null };
    let parsed;
    try { parsed = JSON.parse(summary); } catch { return { code: null, reason: null, shape: null }; }
    const candidate = parsed?.structuredContent?.error ?? parsed?.error ?? null;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { code: null, reason: null, shape: null };
    const codes = new Set(["invalid-provider-response"]);
    const reasons = new Set(["product-list-shape","product-name-missing"]);
    const shapes = new Set([
      "null","string","number","boolean","array-non-object",
      "object-data-array","object-Data-array","object-items-array","object-Items-array",
      "object-produtos-array","object-Produtos-array","object-result-array","object-Result-array",
      "object-results-array","object-Results-array","object-value-array","object-Value-array",
      "object-response-array","object-Response-array","object-error","object-Error",
      "object-errors","object-Errors","object-message","object-Message","object-other",
    ]);
    return {
      code: codes.has(candidate.code) ? candidate.code : null,
      reason: reasons.has(candidate.reason) ? candidate.reason : null,
      shape: shapes.has(candidate.shape) ? candidate.shape : null,
    };
  };
  const safeRateLimit = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const limit = safeInt(value.limit);
    const remaining = safeInt(value.remaining);
    const windowSeconds = safeInt(value.windowSeconds);
    if (limit == null && remaining == null && windowSeconds == null) return null;
    return { limit, remaining, windowSeconds };
  };
  const events = rows
    .filter((row) => row && typeof row === "object")
    .filter((row) => input.runId == null || row.runId === input.runId)
    .filter((row) => input.toolName == null || row.toolName === input.toolName)
    .map((row) => ({
      eventType: safeString(row.eventType, 120),
      runId: safeString(row.runId, 80),
      toolName: safeString(row.toolName, 240),
      decision: safeString(row.decision, 80),
      reasonCode: safeString(row.reasonCode, 160),
      outcome: safeString(row.outcome, 120),
      errorCode: safeString(row.errorCode, 160),
      createdAt: safeString(row.createdAt, 80),
      rateLimitState: safeRateLimit(row.rateLimitState),
      diagnostic: extractDiagnostic(row.resultSummary),
    }));
  result = { connectionId: input.connectionId, count: events.length, events };
} else if (op === "tool-policy-test") {
  const companyId = encodeURIComponent(String(input.companyId ?? ""));
  const body = {
    companyId: input.companyId,
    actor: input.actor,
    runContext: input.runContext ?? null,
    request: input.request,
    consumeRateLimit: false,
    writeAuditEvent: false,
  };
  result = await ctx.api.post("/api/companies/" + companyId + "/tools/policy/test", body);
} else if (op === "tool-policy-create") {
  const companyId = encodeURIComponent(String(input.companyId ?? ""));
  result = await ctx.api.post("/api/companies/" + companyId + "/tools/policies", {
    name: input.name,
    description: input.description ?? null,
    policyType: input.policyType,
    priority: input.priority,
    enabled: true,
    selectors: input.selectors,
    conditions: null,
    config: input.config ?? null,
  });
} else if (op === "tool-policy-delete") {
  const companyId = encodeURIComponent(String(input.companyId ?? ""));
  const policyId = encodeURIComponent(String(input.policyId ?? ""));
  const listing = await ctx.api.get("/api/companies/" + companyId + "/tools/policies");
  const policies = Array.isArray(listing?.policies) ? listing.policies : [];
  const policy = policies.find((x) => x && x.id === input.policyId);
  if (!policy) throw new Error("policy_not_found");
  if (policy.name !== input.expectedName) throw new Error("policy_name_mismatch");
  result = await ctx.api.delete("/api/companies/" + companyId + "/tools/policies/" + policyId);
} else {
  throw new Error("unsupported_paperclip_semantic_operation");
}
process.stdout.write(JSON.stringify({ ok: true, operation: op, result }) + "\n");
`;

export function paperclipSemanticExecCommand(op: PaperclipSemanticOperation, payload: Record<string, unknown>): string[] {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > 180_000) throw new Error("paperclip_payload_too_large");
  return [
    "node",
    "--import",
    "/app/server/node_modules/tsx/dist/loader.mjs",
    "--input-type=module",
    "-e",
    PAPERCLIP_SEMANTIC_SCRIPT,
    op,
    encoded,
  ];
}
