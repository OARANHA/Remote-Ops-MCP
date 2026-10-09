import { redactText } from "../security/redact.js";

export const CANONICAL_PATHS = [
  "docs/PROJECT_SOURCE.md",
  "AGENTS.md",
  "docs/CANONICAL_STATE.md",
  "MEMORY.md",
] as const;

export interface DshTask {
  request_id: string;
  expected_sha: string;
  task: string;
  session_id?: string;
}

const SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseTaskRequest(value: unknown): DshTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["request_id", "expected_sha", "task", "session_id"].includes(key))) throw new Error("unknown_request_field");
  const requestId = obj.request_id;
  const sha = obj.expected_sha;
  const task = obj.task;
  const sessionId = obj.session_id;
  if (typeof requestId !== "string" || !ID_RE.test(requestId)) throw new Error("invalid_request_id");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid_expected_sha");
  if (typeof task !== "string" || task.trim().length < 5 || Buffer.byteLength(task, "utf8") > 8192 || /\0/.test(task)) throw new Error("invalid_task");
  // Known credentials must not be passed as task text. This is defense in depth,
  // NOT a substitute for preventing sensitive files from entering the workspace.
  if (redactText(task) !== task) throw new Error("sensitive_task_denied");
  if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_RE.test(sessionId))) throw new Error("invalid_session_id");
  return { request_id: requestId, expected_sha: sha, task, ...(sessionId ? { session_id: sessionId } : {}) };
}

export function canonicalTaskPrompt(request: DshTask): string {
  return [
    "Você é um executor supervisionado do projeto CRISEDIGITAL / VIGIAFAST.",
    "A fonte da verdade é o checkout Git autorizado, não o histórico desta conversa.",
    "Antes de agir, leia nesta ordem os arquivos docs/PROJECT_SOURCE.md, AGENTS.md, docs/CANONICAL_STATE.md, MEMORY.md,",
    "depois verifique status das ADRs em docs/decisions/, doutrina, skills, código e testes pertinentes.",
    "Execute REAL NOW → PROVEN EVIDENCE → GAPS → REUSE GATE → DECISION.",
    "Se o SHA, a documentação ou as regras não forem coerentes, PARE e informe o impedimento.",
    "Não aceite ADR proposta, não faça merge/deploy, não acesse dados reais de clientes e não altere sistemas fora deste checkout.",
    "Não faça polling de CI; informe o que precisa ser verificado pelo coordenador.",
    "Ao finalizar, informe branch, SHA, arquivos alterados, testes realmente rodados, riscos e próximos passos.",
    "O SHA autorizado para início desta tarefa é: " + request.expected_sha,
    "",
    "TAREFA DELEGADA:",
    request.task,
  ].join("\n");
}

export type SafeDshEvent =
  | { type: "session"; session_id: string }
  | { type: "status"; phase: string; turn?: number; step?: number }
  | { type: "final"; text: string };

const SAFE_PHASES = new Set(["turn_start", "step_start", "step_end", "turn_end"]);

export function safeDshEvent(event: unknown): SafeDshEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const x = event as Record<string, unknown>;
  if (x.type === "session" && typeof x.sessionId === "string" && SESSION_RE.test(x.sessionId)) {
    return { type: "session", session_id: x.sessionId };
  }
  if (x.type === "status" && typeof x.phase === "string" && SAFE_PHASES.has(x.phase)) {
    const out: SafeDshEvent = { type: "status", phase: x.phase };
    if (typeof x.turn === "number" && Number.isInteger(x.turn) && x.turn >= 0 && x.turn <= 1000) out.turn = x.turn;
    if (typeof x.step === "number" && Number.isInteger(x.step) && x.step >= 0 && x.step <= 1000) out.step = x.step;
    return out;
  }
  if (x.type === "final" && typeof x.text === "string") {
    return { type: "final", text: redactText(x.text.slice(0, 4000)) };
  }
  // Intentionally discard: thinking, text fragments, raw tool calls/results,
  // stderr payloads, provider internals and any unknown future event types.
  return null;
}
