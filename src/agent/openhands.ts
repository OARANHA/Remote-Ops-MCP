import { readFile } from "node:fs/promises";
import type { ExecOptions, ExecResult } from "../ssh/pool.js";

const BASE_URL = "http://127.0.0.1:18080";
const KEY_FILE = "/etc/wandora/openhands/session_api_key";
const WORKSPACE = "/projects/mcp-coordination-lab";
const MAX_RESPONSE_BYTES = 131072;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = new Set(["idle","running","paused","waiting_for_confirmation","finished","error","stuck","deleting"]);

type Fetcher = typeof fetch;
export type OpenHandsDependencies = {
  fetcher?: Fetcher;
  readKey?: () => Promise<string>;
  timeoutMs?: number;
};
export type OpenHandsCommand =
  | "openhands.health" | "openhands.list" | "openhands.status"
  | "openhands.result" | "openhands.start" | "openhands.stop";

function requireUuid(value: unknown): string {
  const s = String(value ?? "");
  if (!UUID.test(s)) throw new Error("invalid_conversation_id");
  return s;
}
function safeText(value: unknown, max = 200): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function projectConversation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_openhands_response");
  const x = value as Record<string, unknown>;
  if (typeof x.id !== "string" || !UUID.test(x.id)) throw new Error("invalid_openhands_response");
  return {
    id: x.id,
    title: safeText(x.title),
    execution_status: typeof x.execution_status === "string" && STATUS.has(x.execution_status) ? x.execution_status : "unknown",
    created_at: safeText(x.created_at, 50) || null,
    updated_at: safeText(x.updated_at, 50) || null,
  };
}
async function boundedJson(response: Response): Promise<unknown> {
  const size = response.headers.get("content-length");
  if (size && Number(size) > MAX_RESPONSE_BYTES) throw new Error("openhands_response_too_large");
  if (!response.body) throw new Error("openhands_empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("openhands_response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk,offset); offset+=chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(result)); }
  catch { throw new Error("openhands_invalid_json"); }
}
export async function runOpenHandsCommand(
  command: OpenHandsCommand,
  args: Record<string, unknown> = {},
  deps: OpenHandsDependencies = {},
): Promise<Record<string, unknown>> {
  if (!["openhands.health","openhands.list","openhands.status","openhands.result","openhands.start","openhands.stop"].includes(command))
    throw new Error("openhands_operation_denied");
  let path: string, method = "GET", body: string | undefined;
  if (command === "openhands.health") path = "/health";
  else if (command === "openhands.list") {
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("invalid_limit");
    const url = new URL("/api/conversations/search", BASE_URL);
    url.searchParams.set("limit",String(limit));
    if (args.page_id !== undefined) {
      const pageId = String(args.page_id);
      if (!/^[A-Za-z0-9_=-]{1,256}$/.test(pageId)) throw new Error("invalid_page_id");
      url.searchParams.set("page_id",pageId);
    }
    path = url.pathname + url.search;
  } else if (command === "openhands.start") {
    const task = args.task;
    if (typeof task !== "string" || task.trim().length < 5 || task.length > 4000) throw new Error("invalid_task");
    method = "POST"; path = "/api/conversations";
    body = JSON.stringify({
      workspace: {working_dir: WORKSPACE},
      confirmation_policy: {kind:"AlwaysConfirm"},
      max_iterations: 20,
      worktree: false,
      initial_message: {role:"user", content:[{type:"text",text:task.trim()}]},
    });
  } else {
    const id = requireUuid(args.conversation_id);
    if (command === "openhands.status") path = `/api/conversations/${id}`;
    else if (command === "openhands.result") path = `/api/conversations/${id}/agent_final_response`;
    else { method = "POST"; path = `/api/conversations/${id}/goal/stop`; }
  }
  let credentialValue: string | undefined;
  if (command !== "openhands.health") {
    try { credentialValue = (await (deps.readKey ?? (() => readFile(KEY_FILE, "utf8")))()).trim(); }
    catch { throw new Error("openhands_auth_unconfigured"); }
    if (!credentialValue || credentialValue.length < 16 || credentialValue.length > 4096 || /[\r\n\0]/.test(credentialValue))
      throw new Error("openhands_auth_unconfigured");
  }
  const timeout = Math.min(Math.max(deps.timeoutMs ?? 8000,1000),20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),timeout);
  try {
    const response = await (deps.fetcher ?? fetch)(BASE_URL + path,{
      method,redirect:"error",signal:controller.signal,
      headers: credentialValue ? {"X-Session-API-Key":credentialValue, ...(body ? {"Content-Type":"application/json"} : {})} : {},
      ...(body ? {body}:{}),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("openhands_auth_denied");
      if (response.status === 404) throw new Error("openhands_not_found");
      if (response.status === 429) throw new Error("openhands_rate_limited");
      throw new Error("openhands_http_error_" + response.status);
    }
    const json = await boundedJson(response);
    if (command === "openhands.health") {
      if (!json || typeof json !== "object" || (json as Record<string,unknown>).status !== "ok") throw new Error("openhands_unhealthy");
      return {healthy:true};
    }
    if (command === "openhands.list") {
      if (!json || typeof json !== "object" || !Array.isArray((json as Record<string,unknown>).items)) throw new Error("invalid_openhands_response");
      const d=json as {items:unknown[];next_page_id?:unknown};
      return {items:d.items.map(projectConversation),next_page_id:typeof d.next_page_id==="string"?safeText(d.next_page_id,256):null};
    }
    if (command === "openhands.status" || command === "openhands.start") return projectConversation(json);
    if (command === "openhands.result") {
      if (!json || typeof json !== "object") throw new Error("invalid_openhands_response");
      return {conversation_id:requireUuid(args.conversation_id),response:safeText((json as Record<string,unknown>).response,4000)};
    }
    return {conversation_id:requireUuid(args.conversation_id),stop_requested:true};
  } catch(error) {
    if (error instanceof Error && error.name==="AbortError") throw new Error("openhands_timeout");
    if (error instanceof Error && error.message.startsWith("openhands_") || error instanceof Error && error.message==="invalid_openhands_response") throw error;
    throw new Error("openhands_unavailable");
  } finally { clearTimeout(timer); }
}
export async function executeOpenHandsOperation(
  x: {op:string; args?:Record<string,unknown>}, opts?:ExecOptions,
): Promise<ExecResult> {
  const started=Date.now();
  try {
    const result = await runOpenHandsCommand(x.op as OpenHandsCommand, x.args??{}, {timeoutMs:opts?.timeoutMs});
    return {code:0, stdout:JSON.stringify(result), stderr:"",durationMs:Date.now()-started,truncated:false,timedOut:false};
  } catch(err) {
    const msg = err instanceof Error ? err.message : "openhands_unavailable";
    const allowed = /^(?:openhands_[a-z_]+|openhands_http_error_[0-9]+|invalid_[a-z_]+|invalid_openhands_response)$/;
    return {code:1,stdout:"",stderr:allowed.test(msg)?msg:"openhands_unavailable",durationMs:Date.now()-started,truncated:false,timedOut:msg==="openhands_timeout"};
  }
}
