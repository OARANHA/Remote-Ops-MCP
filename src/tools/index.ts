import { z, type ZodRawShape } from "zod";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { assertIdentifier } from "../lib/quote.js";
import { getTarget, listTargets, publicTarget, targetIds } from "../config/targets.js";
import { prepareAgentTarget, applyAgentTargetApproval } from "../config/target-approvals.js";
import { describeTargetCapabilityBaseline } from "../config/capability-baseline.js";
import { prepareManagedAdminAction, consumeManagedAdminApproval } from "../config/managed-admin-approvals.js";
import type { TargetConfig } from "../config/targets.js";
import { getTransport } from "../transport.js";
import { assertConfiguredPath, resolveCheckedGitRepo, resolveCheckedPath, resolveCheckedProcessCwd } from "../security/paths.js";
import { dispatchAgentOperation } from "../agent/gateway.js";
import { redactText, redactObject } from "../security/redact.js";
import type { ExecResult } from "../ssh/pool.js";
import { effectiveTargetEnabled } from "../state/store.js";
import { portainerStatus, portainerEndpoints, portainerStacks, portainerStack, updatePortainerStackEnv, redeployPortainerGitStack, createPortainerGitStack, startPortainerStack, stopPortainerStack, deletePortainerStack } from "../portainer/client.js";

/**
 * TOOLS V1 — 100% READ-ONLY.
 * - Comandos são templates fixos; todo parâmetro é validado e quotado.
 * - Sem shell arbitrário, sem sudo, sem escrita.
 * - Toda saída passa pela redação de segredos.
 */

export interface ToolCtx {
  actor: string;
  requestId: string;
  clientId?: string;
  sessionId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
  mutation?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

// ---------- helpers ----------

function resolveTarget(id: unknown): TargetConfig {
  if (typeof id !== "string" || !id) {
    throw new OpsError("INVALID_ARGUMENT", "parâmetro target é obrigatório");
  }
  const t = getTarget(id);
  if (!t) {
    throw new OpsError(
      "TARGET_NOT_FOUND",
      `target "${id}" não existe no registry`,
      `targets disponíveis: ${targetIds().join(", ") || "(nenhum)"}`
    );
  }
  if (!effectiveTargetEnabled(t.id, t.enabled)) {
    throw new OpsError("TARGET_DISABLED", `target "${id}" está desabilitado`);
  }
  return t;
}

function targetCapabilitySummary(t: TargetConfig) {
  return {
    id: t.id,
    environment: t.environment,
    capabilityProfile: t.capabilityProfile,
    transport: t.transport,
    enabled: effectiveTargetEnabled(t.id, t.enabled),
    capabilityBaseline: describeTargetCapabilityBaseline(t),
  };
}

function checkAllow(list: string[], value: string, kind: string, code: "CONTAINER_NOT_ALLOWED" | "SERVICE_NOT_ALLOWED" | "REPO_NOT_ALLOWED"): void {
  if (list.includes("*")) return;
  if (!list.includes(value)) {
    throw new OpsError(code, `${kind} "${value}" não está na allowlist do target`, `allowlist: ${list.join(", ") || "(vazia)"}`);
  }
}

function requireExec(res: ExecResult, argv0: string): ExecResult {
  if (res.code === null) {
    throw new OpsError("SSH_UNAVAILABLE", `comando interrompido (${argv0})`);
  }
  return res;
}

function dockerAccessError(res: ExecResult): never {
  if (/permission denied|permission.*docker/i.test(res.stderr)) {
    throw new OpsError(
      "DOCKER_ACCESS_DENIED",
      "sem permissão para acessar o Docker daemon",
      "Docker permanece negado por segurança; habilite somente por broker read-only dedicado — nunca adicione ops-mcp ao grupo docker"
    );
  }
  throw new OpsError("REMOTE_COMMAND_FAILED", `docker retornou erro (exit ${res.code})`, res.stderr.slice(0, 200));
}

function journalAccessNote(res: ExecResult): string | undefined {
  if (res.code === 0 && res.stdout.trim() === "") {
    return "journal vazio para este usuário — adicione ops-mcp ao grupo systemd-journal: sudo usermod -aG systemd-journal ops-mcp";
  }
  if (/permission denied/i.test(res.stderr)) {
    return "sem permissão de journal — adicione ops-mcp ao grupo systemd-journal";
  }
  return undefined;
}

function humanBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

async function tr(t: TargetConfig) {
  return getTransport(t);
}

async function agentJson(t: TargetConfig, op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  if (t.transport !== "agent" || !t.deviceId) throw new OpsError("INVALID_ARGUMENT", "esta capacidade exige target transport=agent");
  const res = await dispatchAgentOperation(t.deviceId, { op, args }, { timeoutMs, maxBytes: 1024 * 1024 });
  if (res.code !== 0) throw new OpsError("REMOTE_COMMAND_FAILED", `Agent execution broker recusou ${op}`, redactText(res.stderr).slice(0, 500));
  try { return redactObject(JSON.parse(res.stdout || "{}")) as Record<string, unknown>; }
  catch { throw new OpsError("REMOTE_COMMAND_FAILED", `resposta inválida do execution broker para ${op}`); }
}

function requireOperator(t: TargetConfig): void {
  if (t.capabilityProfile !== "operator") throw new OpsError("INVALID_ARGUMENT", `target "${t.id}" não está no capability profile operator`);
}

function requireOpenHandsExecutor(t: TargetConfig): void {
  // A dedicated semantic-only profile avoids generic operator process/session access.
  if (t.capabilityProfile !== "semantic-operator") throw new OpsError("CAPABILITY_DENIED", "OpenHands exige target de execução semântica dedicado");
  requireSemanticCapability(t, "openhands.execute");
}

function requireProgram(t: TargetConfig, value: unknown): string {
  const program = String(value ?? "");
  if (!/^[A-Za-z0-9_.+-]{1,80}$/.test(program)) throw new OpsError("INVALID_ARGUMENT", "program inválido");
  if (!t.allowedProcessPrograms.includes(program)) throw new OpsError("INVALID_ARGUMENT", `program "${program}" não está na allowlist`, `allowlist: ${t.allowedProcessPrograms.join(", ") || "(vazia)"}`);
  return program;
}

function requireNamedCapability(list: string[], value: unknown, label: string): string {
  const item=String(value??"");
  if(!/^[A-Za-z0-9_.+-]{1,100}$/.test(item)) throw new OpsError("INVALID_ARGUMENT", `${label} inválido`);
  if(!list.includes("*")&&!list.includes(item)) throw new OpsError("CAPABILITY_DENIED", `${label} "${item}" não está na allowlist`, `allowlist: ${list.join(", ") || "(vazia)"}`);
  return item;
}

function requirePrefixCapability(prefixes: string[], value: unknown, label: string): string {
  const item=String(value??"");
  if(!/^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/.test(item)) throw new OpsError("INVALID_ARGUMENT", `${label} inválido`);
  if(prefixes.length===0||!prefixes.some((prefix)=>prefix==="*"||item.startsWith(prefix))) {
    throw new OpsError("CAPABILITY_DENIED", `${label} "${item}" não corresponde a nenhum prefixo permitido`, `prefixos: ${prefixes.join(", ") || "(vazia)"}`);
  }
  return item;
}

function requireCandidateName(prefixes: string[], value: unknown): string {
  const name=assertIdentifier(String(value??""),"candidate");
  if(prefixes.length===0||!prefixes.some((prefix)=>prefix==="*"||name.startsWith(prefix))) {
    throw new OpsError("CAPABILITY_DENIED", `candidate "${name}" não corresponde a nenhum prefixo permitido`, `prefixos: ${prefixes.join(", ") || "(vazia)"}`);
  }
  return name;
}

function requireAllowedPort(ports: number[], value: unknown, label: string): number {
  const port=Number(value);
  if(!Number.isInteger(port)||port<1||port>65535) throw new OpsError("INVALID_ARGUMENT", `${label} inválida`);
  if(!ports.includes(port)) throw new OpsError("CAPABILITY_DENIED", `${label} ${port} não está na allowlist`, `allowlist: ${ports.join(", ") || "(vazia)"}`);
  return port;
}

function requireAgentMutationTransport(t: TargetConfig): void {
  if(t.transport!=="agent") throw new OpsError("CAPABILITY_DENIED", `target "${t.id}" precisa usar transport=agent para mutações Docker governadas`);
}

function requireSemanticCapability(t: TargetConfig, capability: string): void {
  if(t.transport!=="agent") throw new OpsError("CAPABILITY_DENIED", `target "${t.id}" precisa usar transport=agent para capability semântica`);
  requireNamedCapability(t.allowedSemanticCapabilities, capability, "capability semântica");
}

function requirePaperclipSemantic(t: TargetConfig): void {
  requireOperator(t);
  requireAgentMutationTransport(t);
  checkAllow(t.allowedDockerExecContainers, "wandora-paperclip", "contêiner Paperclip semântico", "CONTAINER_NOT_ALLOWED");
}

function unwrapPaperclipResult(t: TargetConfig, value: Record<string, unknown>): Record<string, unknown> {
  const result = value.result;
  if (result && typeof result === "object" && !Array.isArray(result)) return { target: t.id, ...(result as Record<string, unknown>) };
  return { target: t.id, result: result ?? null };
}

// ---------- tools ----------

const targetField = z
  .string()
  .min(1)
  .max(64)
  .describe("ID do target no Target Registry (ex.: wandora-prod). Use targets_list para ver os IDs.");

const paperclipGuid = z.string().uuid();
const paperclipActor = z.object({
  actorType: z.enum(["agent","user","system","plugin"]),
  actorId: z.string().trim().min(1).max(240),
  agentId: paperclipGuid.optional().nullable(),
}).strict();
const paperclipRunContext = z.object({
  heartbeatRunId: paperclipGuid.optional().nullable(),
  issueId: paperclipGuid.optional().nullable(),
  projectId: paperclipGuid.optional().nullable(),
  routineId: paperclipGuid.optional().nullable(),
  gatewayId: paperclipGuid.optional().nullable(),
  gatewayPublicId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/).optional().nullable(),
  gatewayTokenId: paperclipGuid.optional().nullable(),
  clientSubjectType: z.enum(["gateway_client","heartbeat_run","board_user","agent"]).optional().nullable(),
  clientSubjectId: z.string().trim().min(1).max(240).optional().nullable(),
  clientName: z.string().trim().min(1).max(160).optional().nullable(),
  externalClient: z.boolean().optional().nullable(),
}).strict();
const paperclipPolicyRequest = z.object({
  applicationId: paperclipGuid.optional().nullable(),
  connectionId: paperclipGuid.optional().nullable(),
  catalogEntryId: paperclipGuid.optional().nullable(),
  toolName: z.string().trim().min(1).max(240),
  arguments: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(1).max(512).optional().nullable(),
  sideEffecting: z.boolean().optional(),
}).strict();

const paperclipPolicySelectors = z.object({
  agentId: paperclipGuid.optional(),
  connectionId: paperclipGuid.optional(),
  catalogEntryId: paperclipGuid.optional(),
  toolName: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  toolNames: z.array(z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)).min(1).max(32).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "at least one selector is required" });

const paperclipRateLimitConfig = z.object({
  limit: z.number().int().min(1).max(1000),
  windowSeconds: z.number().int().min(1).max(86400),
  keyBy: z.array(z.enum(["agent","tool","connection"])).min(1).max(4),
}).strict();

const TOOL_DEFS: ToolDef[] = [
  // ============ servidor ============
  {
    name: "health",
    description: "Status do servidor MCP (não acessa nenhuma VPS): versão, modo de auth, modo ensaio, quantidade de targets.",
    inputSchema: {},
    run: async () => ({
      status: "ok",
      service: "remote-ops-mcp",
      version: "2.0.0-dev",
      authMode: env.AUTH_MODE,
      mockMode: env.MOCK_MODE === "1",
      targets: targetIds(),
    }),
  },
  {
    name: "targets_list",
    description: "Lista os targets registrados no Target Registry (sem acessar as VPS).",
    inputSchema: {},
    run: async () => ({
      targets: listTargets().map((t) => ({
        id: t.id,
        environment: t.environment,
        capabilityProfile: t.capabilityProfile,
        transport: t.transport,
        enabled: effectiveTargetEnabled(t.id, t.enabled),
      })),
    }),
  },
  {
    name: "target_status",
    description: "Resumo governado do target por padrão. Use detail=full somente quando allowlists exatas forem explicitamente necessárias para diagnóstico/decisão. Não conecta na VPS.",
    inputSchema: {
      target: targetField,
      detail: z.enum(["summary","full"]).optional().describe("summary (padrão) ou full para allowlists exatas"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      return args.detail === "full" ? publicTarget(t) : targetCapabilitySummary(t);
    },
  },
  {
    name: "target_agent_prepare",
    description: "Prepara, sem aplicar, a criação/atualização de um target Agent Mesh dinâmico. Retorna um código adm_... que deve ser explicitamente confirmado pelo usuário no chat como 'APPROVE adm_...'. Não altera targets estáticos nem reinicia o control plane.",
    inputSchema: {
      target_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
      device_id: z.string().regex(/^dev_[A-Za-z0-9_-]{8,80}$/),
      environment: z.enum(["production","staging","development"]).default("production"),
      preset: z.enum(["operator-workspace","read-only","openhands-read","openhands-execute","postgres-readback","managed-admin"]).default("operator-workspace"),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args, ctx) => prepareAgentTarget({
      actor: ctx.actor,
      targetId: String(args.target_id),
      deviceId: String(args.device_id),
      environment: (args.environment ?? "production") as "production"|"staging"|"development",
      preset: (args.preset ?? "operator-workspace") as "operator-workspace"|"read-only"|"openhands-read"|"openhands-execute"|"postgres-readback"|"managed-admin",
    }),
  },
  {
    name: "target_agent_apply",
    description: "Aplica uma aprovação preparada por target_agent_prepare. Só use depois que o usuário tiver ecoado explicitamente no chat a confirmação exata 'APPROVE adm_...'. Grava apenas o overlay dinâmico em /app/data e recarrega o registry em memória, sem restart e sem modificar targets estáticos.",
    inputSchema: {
      approval_id: z.string().regex(/^adm_[a-f0-9]{24}$/),
      confirmation: z.string().min(1).max(80),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args, ctx) => {
      const applied = applyAgentTargetApproval({
        actor: ctx.actor,
        approvalId: String(args.approval_id),
        confirmation: String(args.confirmation),
      });
      const targetId = String((applied.target as { id?: unknown }).id ?? "");
      const target = resolveTarget(targetId);
      return {
        approval_id: applied.approval_id,
        applied: applied.applied,
        target: targetCapabilitySummary(target),
        summary: applied.summary,
        detail_hint: "Use target_status com detail=full se uma decisão exigir allowlists exatas.",
      };
    },
  },

  {
    name: "host_admin_prepare",
    description: "Prepara uma ação administrativa root assinada para um target managed-admin. Não executa nada. Retorna adm_... e exige confirmação explícita do usuário.",
    inputSchema: {
      target: targetField,
      program: z.string().regex(/^[A-Za-z0-9_.+-]{1,80}$/),
      args: z.array(z.string().max(16384)).max(80).optional(),
      cwd: z.string().min(1).max(1024).optional(),
      timeout_ms: z.coerce.number().int().min(1000).max(120000).optional(),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args, ctx) => prepareManagedAdminAction({
      actor: ctx.actor,
      targetId: String(args.target),
      program: args.program,
      argv: args.args,
      cwd: args.cwd,
      timeoutMs: args.timeout_ms,
    }),
  },
  {
    name: "host_admin_apply",
    description: "Executa exatamente uma ação previamente preparada por host_admin_prepare. Só use após o usuário confirmar exatamente 'APPROVE adm_...'. O ticket root é assinado, de uso único e de curta duração.",
    inputSchema: {
      target: targetField,
      approval_id: z.string().regex(/^adm_[a-f0-9]{24}$/),
      confirmation: z.string().min(1).max(80),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args, ctx) => {
      const approved = consumeManagedAdminApproval({
        actor: ctx.actor,
        targetId: String(args.target),
        approvalId: String(args.approval_id),
        confirmation: String(args.confirmation),
      });
      const result = await agentJson(
        approved.target,
        "host.managed_admin",
        { ticket: approved.ticket, signature: approved.signature },
        Math.min(approved.ticket.timeout_ms + 5_000, 120_000),
      );
      if (result.exit_code !== 0 || result.timed_out === true) {
        throw new OpsError(
          "REMOTE_COMMAND_FAILED",
          `managed-admin falhou (exit ${String(result.exit_code)})`,
          String(result.stderr ?? "").slice(0, 500),
        );
      }
      return {
        target: approved.target.id,
        approval_id: approved.approvalId,
        summary: approved.summary,
        executed: true,
        result,
      };
    },
  },

  // ============ host ============
  {
    name: "host_status",
    description: "Status básico do host: hostname, kernel, load average, uptime e distribuição.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const hostname = await T.exec(["hostname"]);
      requireExec(hostname, "hostname");
      const [kernel, load, up, os] = await Promise.all([
        T.exec(["uname", "-srm"]).catch(() => null),
        T.exec(["cat", "/proc/loadavg"]).catch(() => null),
        T.exec(["uptime", "-p"]).catch(() => null),
        T.exec(["head", "-n", "5", "/etc/os-release"]).catch(() => null),
      ]);
      const loadParts = (load?.stdout ?? "").trim().split(/\s+/);
      return {
        target: t.id,
        hostname: hostname.stdout.trim(),
        kernel: kernel?.stdout.trim(),
        load: { one: loadParts[0], five: loadParts[1], fifteen: loadParts[2] },
        uptime: up?.stdout.trim(),
        os: os?.stdout.trim(),
        duration_ms: hostname.durationMs,
      };
    },
  },
  {
    name: "disk_usage",
    description: "Uso de disco (df -hP) com resumo da partição raiz.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const res = requireExec(await T.exec(["df", "-hP"]), "df");
      const rows: Array<{ filesystem: string; size: string; used: string; avail: string; use: string; mounted_on: string }> = [];
      for (const line of res.stdout.split("\n").slice(1)) {
        const m = /^(.+?)\s+([0-9.]+[KMGTPE]?)\s+([0-9.]+[KMGTPE]?)\s+([0-9.]+[KMGTPE]?)\s+(\d+%)\s+(.+)$/.exec(line.trim());
        if (m) rows.push({ filesystem: m[1], size: m[2], used: m[3], avail: m[4], use: m[5], mounted_on: m[6] });
      }
      const root = rows.find((r) => r.mounted_on === "/");
      return { target: t.id, root_summary: root ?? null, filesystems: rows, truncated: res.truncated };
    },
  },
  {
    name: "memory_status",
    description: "Uso de memória e swap (free -b), com percentuais.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const res = requireExec(await T.exec(["free", "-b"]), "free");
      const memLine = res.stdout.split("\n").find((l) => l.startsWith("Mem:"));
      const swapLine = res.stdout.split("\n").find((l) => l.startsWith("Swap:"));
      const cols = (line?: string) => (line ? line.split(/\s+/).slice(1).map(Number) : []);
      const m = cols(memLine);
      const s = cols(swapLine);
      const mem = m.length >= 4 ? { total: m[0], used: m[1], free: m[2], available: m[6] ?? m[2], used_pct: Math.round((m[1] / m[0]) * 100) } : null;
      const swap = s.length >= 3 && s[0] > 0 ? { total: s[0], used: s[1], free: s[2], used_pct: Math.round((s[1] / s[0]) * 100) } : { total: s[0] ?? 0, used: s[1] ?? 0, free: s[2] ?? 0, used_pct: 0 };
      return {
        target: t.id,
        mem: mem ? { ...mem, total_human: humanBytes(mem.total), used_human: humanBytes(mem.used), available_human: humanBytes(mem.available) } : null,
        swap,
      };
    },
  },
  {
    name: "uptime",
    description: "Uptime do host (formato legível + desde quando).",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const [pretty, since] = await Promise.all([T.exec(["uptime", "-p"]), T.exec(["uptime", "-s"])]);
      return { target: t.id, uptime: pretty.stdout.trim(), since: since.stdout.trim() };
    },
  },

  // ============ docker ============
  {
    name: "docker_list",
    description: "Lista contêineres Docker (ps -a) do target: nome, imagem, estado, status, portas.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const res = await T.exec(["docker", "ps", "-a", "--format", "{{json .}}"]);
      if (res.code !== 0) dockerAccessError(res);
      const containers = res.stdout
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 100)
        .map((l) => {
          try {
            const o = JSON.parse(l) as Record<string, unknown>;
            return { id: o.ID, name: o.Names, image: o.Image, state: o.State, status: o.Status, ports: o.Ports ?? "" };
          } catch {
            return { raw: redactText(l) };
          }
        });
      return { target: t.id, count: containers.length, containers };
    },
  },
  {
    name: "docker_health",
    description: "Saúde de um contêiner específico: estado, healthcheck, iniciado em, restarts.",
    inputSchema: {
      target: targetField,
      container: z.string().min(1).max(100).describe("Nome do contêiner (ex.: wandora-web)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const container = assertIdentifier(String(args.container ?? ""), "container");
      checkAllow(t.allowedDockerContainers, container, "contêiner", "CONTAINER_NOT_ALLOWED");
      const T = await tr(t);
      const res = await T.exec(["docker", "inspect", "--format", "{{json .State}}", container]);
      if (res.code !== 0) dockerAccessError(res);
      let state: Record<string, unknown> = {};
      try {
        state = JSON.parse(res.stdout.trim().split("\n")[0]) as Record<string, unknown>;
      } catch {
        throw new OpsError("REMOTE_COMMAND_FAILED", "saída de inspect não é JSON válido");
      }
      return {
        target: t.id,
        container,
        status: state.Status ?? null,
        running: state.Running ?? null,
        health: (state.Health as { Status?: string } | undefined)?.Status ?? null,
        started_at: state.StartedAt ?? null,
        restart_count: state.RestartCount ?? null,
      };
    },
  },
  {
    name: "docker_inspect_safe",
    description: "Inspect de um contêiner com sanitização: Config.Env é removido e valores sensíveis são redigidos.",
    inputSchema: {
      target: targetField,
      container: z.string().min(1).max(100).describe("Nome do contêiner"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const container = assertIdentifier(String(args.container ?? ""), "container");
      checkAllow(t.allowedDockerContainers, container, "contêiner", "CONTAINER_NOT_ALLOWED");
      const T = await tr(t);
      const res = await T.exec(["docker", "inspect", container]);
      if (res.code !== 0) dockerAccessError(res);
      let items: unknown[];
      try {
        items = JSON.parse(res.stdout) as unknown[];
      } catch {
        throw new OpsError("REMOTE_COMMAND_FAILED", "saída de inspect não é JSON válido");
      }
      const sanitized = (Array.isArray(items) ? items : []).map((item) => {
        const obj = item as Record<string, unknown>;
        const config = obj?.Config as Record<string, unknown> | undefined;
        if (config && Array.isArray(config.Env)) {
          config.Env = `[${config.Env.length} variáveis de ambiente REMOVIDAS]`;
        }
        if (obj.AuthConfig) delete obj.AuthConfig;
        return redactObject(obj);
      });
      return { target: t.id, container, inspect: sanitized };
    },
  },
  {
    name: "docker_logs",
    description: "Logs recentes de um contêiner (limitado a 500 linhas, com timestamps, redigido).",
    inputSchema: {
      target: targetField,
      container: z.string().min(1).max(100).describe("Nome do contêiner"),
      lines: z.coerce.number().int().min(1).max(env.MAX_LOG_LINES).optional().describe("Quantas linhas (padrão 100, máx 500)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const container = assertIdentifier(String(args.container ?? ""), "container");
      const lines = Math.min(Math.max(Number(args.lines ?? 100), 1), env.MAX_LOG_LINES);
      checkAllow(t.allowedDockerContainers, container, "contêiner", "CONTAINER_NOT_ALLOWED");
      const T = await tr(t);
      const res = await T.exec(["docker", "logs", "--tail", String(lines), "--timestamps", container]);
      if (res.code !== 0 && /permission denied/i.test(res.stderr)) dockerAccessError(res);
      return {
        target: t.id,
        container,
        requested_lines: lines,
        exit_code: res.code,
        truncated: res.truncated,
        output: redactText(res.stdout + (res.stderr ? "\n[stderr]\n" + res.stderr : "")),
      };
    },
  },

  {
    name: "docker_exec",
    description: "Executa um programa allowlisted dentro de um contêiner allowlisted. Sem shell implícito, sem env/user/privileged override e com saída redigida.",
    inputSchema: {
      target: targetField,
      container: z.string().min(1).max(100),
      program: z.string().min(1).max(80),
      args: z.array(z.string().max(16384)).max(80).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireOperator(t);
      requireAgentMutationTransport(t);
      const container=assertIdentifier(String(args.container??""),"container");
      checkAllow(t.allowedDockerExecContainers,container,"contêiner para exec","CONTAINER_NOT_ALLOWED");
      const program=requireNamedCapability(t.allowedDockerExecPrograms,args.program,"programa docker exec");
      const argv=Array.isArray(args.args)?args.args.map(String):[];
      const T=await tr(t);
      const res=await T.exec(["docker","exec",container,program,...argv],{timeoutMs:t.commandTimeoutMs??30_000,maxBytes:env.MAX_OUTPUT_BYTES});
      if(res.code!==0 && /permission denied|not_allowed|denied/i.test(res.stderr)) dockerAccessError(res);
      return {target:t.id,container,program,exit_code:res.code,timed_out:res.timedOut,truncated:res.truncated,stdout:redactText(res.stdout),stderr:redactText(res.stderr)};
    },
  },
  {
    name: "docker_action",
    description: "Executa ação Docker explicitamente allowlisted. Além de start/stop/restart, pode carregar imagem .tar ou gerir candidate descartável quando as allowlists específicas estiverem configuradas.",
    inputSchema: {
      target: targetField,
      action: z.enum(["start","stop","restart","load_image","candidate_run","candidate_remove"]),
      container: z.string().min(1).max(100).optional(),
      path: z.string().min(1).max(1024).optional(),
      name: z.string().min(1).max(100).optional(),
      image: z.string().min(1).max(200).optional(),
      network: z.string().min(1).max(100).optional(),
      host_port: z.number().int().min(1024).max(65535).optional(),
      container_port: z.number().int().min(1).max(65535).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireOperator(t);
      requireAgentMutationTransport(t);
      const action=requireNamedCapability(t.allowedDockerActions,args.action,"ação docker");
      if(["start","stop","restart"].includes(action)){
        const container=assertIdentifier(String(args.container??""),"container");
        checkAllow(t.allowedDockerContainers,container,"contêiner","CONTAINER_NOT_ALLOWED");
        const T=await tr(t);
        const res=await T.exec(["docker",action,container],{timeoutMs:t.commandTimeoutMs??30_000});
        if(res.code!==0) dockerAccessError(res);
        return {target:t.id,container,action,status:"ok",output:redactText(res.stdout)};
      }
      if(action==="load_image"){
        const path=assertConfiguredPath(String(args.path??""),t.allowedDockerImageLoadRoots,"Docker image load");
        if(!path.endsWith(".tar")) throw new OpsError("INVALID_ARGUMENT","load_image aceita somente arquivo .tar");
        const value=await agentJson(t,"docker.image_load",{path},120_000);
        return {target:t.id,action,...value};
      }
      if(action==="candidate_run"){
        const name=requireCandidateName(t.allowedDockerCandidateNamePrefixes,args.name);
        const image=requirePrefixCapability(t.allowedDockerCandidateImagePrefixes,args.image,"imagem candidate");
        const network=requireNamedCapability(t.allowedDockerCandidateNetworks,args.network,"rede candidate");
        const hostPort=requireAllowedPort(t.allowedDockerCandidateHostPorts,args.host_port,"porta host candidate");
        const containerPort=requireAllowedPort(t.allowedDockerCandidateContainerPorts,args.container_port,"porta container candidate");
        const value=await agentJson(t,"docker.candidate_run",{name,image,network,hostPort,containerPort},60_000);
        return {target:t.id,action,...value};
      }
      if(action==="candidate_remove"){
        const name=requireCandidateName(t.allowedDockerCandidateNamePrefixes,args.name);
        const value=await agentJson(t,"docker.candidate_remove",{name},30_000);
        return {target:t.id,action,...value};
      }
      throw new OpsError("INVALID_ARGUMENT","ação docker não suportada");
    },
  },

  // ============ PostgreSQL pinned semantic readback ============
  {
    name: "postgres_pinned_verifier_readback",
    description: "Executa somente um verifier PostgreSQL cujo SQL corresponda ao SHA-256 aprovado no proxy local. O proxy força sessão/transaction read-only, container/DB/user fixos e não expõe credenciais nem docker_exec genérico.",
    inputSchema: {
      target: targetField,
      verifier_id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,79}$/),
      sql: z.string().min(1).max(128 * 1024),
    },
    mutation: false,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireSemanticCapability(t,"postgres.pinned_readback");
      const value=await agentJson(t,"postgres.pinned_readback",{
        verifierId:String(args.verifier_id),
        sql:String(args.sql),
      },30_000);
      return {target:t.id,...value};
    },
  },

  // ============ Paperclip semantic operator capabilities ============
  {
    name: "paperclip_task_drain_status",
    description: "Lê o status oficial do Task Drain do Paperclip via GET /api/instance/task-drain usando a credencial Board protegida dentro de wandora-paperclip. Não expõe token nem auth store.",
    inputSchema: { target: targetField },
    mutation: false,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.task_drain_status",{},20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_tool_policies_list",
    description: "Lista as Tool Policies oficiais de uma company Paperclip via GET /api/companies/:companyId/tools/policies, preservando a credencial Board dentro do container.",
    inputSchema: {
      target: targetField,
      company_id: paperclipGuid.describe("Company ID Paperclip (UUID)"),
    },
    mutation: false,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.tool_policies_list",{companyId:String(args.company_id)},20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_tool_connection_activity_safe",
    description: "Lê evidência governada recente de uma Tool Connection Paperclip e devolve somente uma projeção allowlisted: eventType, runId, toolName, decisão/outcome, rate-limit numérico e diagnóstico code/reason/shape. Não expõe argumentos, metadata, summaries brutos nem credencial Board.",
    inputSchema: {
      target: targetField,
      company_id: paperclipGuid.describe("Company ID Paperclip (UUID)"),
      connection_id: paperclipGuid.describe("Tool Connection ID Paperclip (UUID)"),
      limit: z.number().int().min(1).max(100).default(20),
      run_id: paperclipGuid.describe("Heartbeat run ID Paperclip (UUID)"),
      tool_name: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/),
    },
    mutation: false,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.tool_connection_activity_safe",{
        companyId:String(args.company_id),
        connectionId:String(args.connection_id),
        limit:Number(args.limit??20),
        runId:String(args.run_id),
        toolName:String(args.tool_name),
      },20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_tool_policy_test",
    description: "Qualifica uma decisão de Tool Policy oficial do Paperclip sem consumir rate limit e sem escrever audit event. A capability força consumeRateLimit=false e writeAuditEvent=false; o caller não pode sobrescrever esses flags.",
    inputSchema: {
      target: targetField,
      company_id: paperclipGuid.describe("Company ID Paperclip (UUID)"),
      actor: paperclipActor,
      run_context: paperclipRunContext.optional().nullable(),
      request: paperclipPolicyRequest,
    },
    mutation: false,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.tool_policy_test",{
        companyId:String(args.company_id),
        actor:args.actor as Record<string,unknown>,
        runContext:(args.run_context??null) as Record<string,unknown>|null,
        request:args.request as Record<string,unknown>,
      },20_000);
      return unwrapPaperclipResult(t,value);
    },
  },

  {
    name: "paperclip_task_drain_start",
    description: "Inicia o Task Drain oficial do Paperclip com TTL explícito e limitado a 24h, usando a credencial Board protegida dentro de wandora-paperclip.",
    inputSchema: {
      target: targetField,
      ttl_ms: z.number().int().positive().max(86_400_000),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.task_drain_start",{ttlMs:Number(args.ttl_ms)},20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_task_drain_stop",
    description: "Encerra o Task Drain oficial do Paperclip. Não expõe nem copia a credencial Board.",
    inputSchema: { target: targetField },
    mutation: true,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.task_drain_stop",{},20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_tool_policy_create",
    description: "Cria policy Paperclip governada limitada a block ou rate_limit, com selectors allowlisted. Não aceita conditions arbitrárias.",
    inputSchema: {
      target: targetField,
      company_id: paperclipGuid,
      name: z.string().trim().min(1).max(160),
      description: z.string().max(4000).optional().nullable(),
      policy_type: z.enum(["block","rate_limit"]),
      priority: z.number().int().min(0).max(10000).default(100),
      selectors: paperclipPolicySelectors,
      config: paperclipRateLimitConfig.optional().nullable(),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.tool_policy_create",{
        companyId:String(args.company_id),
        name:String(args.name),
        description:args.description??null,
        policyType:String(args.policy_type),
        priority:Number(args.priority??100),
        selectors:args.selectors as Record<string,unknown>,
        config:(args.config??null) as Record<string,unknown>|null,
      },20_000);
      return unwrapPaperclipResult(t,value);
    },
  },
  {
    name: "paperclip_tool_policy_delete",
    description: "Remove uma policy Paperclip somente quando o ID e o nome esperado conferem, evitando exclusão acidental de policy diferente.",
    inputSchema: {
      target: targetField,
      company_id: paperclipGuid,
      policy_id: paperclipGuid,
      expected_name: z.string().trim().min(1).max(160),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requirePaperclipSemantic(t);
      const value=await agentJson(t,"paperclip.tool_policy_delete",{
        companyId:String(args.company_id),
        policyId:String(args.policy_id),
        expectedName:String(args.expected_name),
      },20_000);
      return unwrapPaperclipResult(t,value);
    },
  },

  // ============ serviços (systemd) ============
  {
    name: "service_status",
    description: "Status de um serviço systemd: Load/Active/Sub states, PID, memória, restarts.",
    inputSchema: {
      target: targetField,
      service: z.string().min(1).max(100).describe("Nome do serviço (ex.: wandora-core ou wandora-core.service)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const service = assertIdentifier(String(args.service ?? ""), "service");
      const unit = service.includes(".") ? service : `${service}.service`;
      checkAllow(t.allowedServices, service, "serviço", "SERVICE_NOT_ALLOWED");
      const T = await tr(t);
      const res = await T.exec([
        "systemctl", "show", unit,
        "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "UnitFileState",
        "-p", "ExecMainPID", "-p", "MemoryCurrent", "-p", "NRestarts", "-p", "FragmentPath",
        "--no-pager",
      ]);
      const props: Record<string, string> = {};
      for (const line of res.stdout.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
      }
      return {
        target: t.id,
        unit,
        load: props.LoadState ?? null,
        active: props.ActiveState ?? null,
        sub: props.SubState ?? null,
        unit_file: props.UnitFileState ?? null,
        pid: Number(props.ExecMainPID) || null,
        memory_bytes: Number(props.MemoryCurrent) || null,
        restarts: Number(props.NRestarts) || 0,
        fragment: props.FragmentPath ?? null,
        note: res.code !== 0 ? redactText(res.stderr.slice(0, 200)) : undefined,
      };
    },
  },
  {
    name: "service_logs",
    description: "Logs recentes de um serviço systemd via journalctl (limitado a 500 linhas, redigido).",
    inputSchema: {
      target: targetField,
      service: z.string().min(1).max(100).describe("Nome do serviço"),
      lines: z.coerce.number().int().min(1).max(env.MAX_LOG_LINES).optional().describe("Quantas linhas (padrão 100, máx 500)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const service = assertIdentifier(String(args.service ?? ""), "service");
      const lines = Math.min(Math.max(Number(args.lines ?? 100), 1), env.MAX_LOG_LINES);
      const unit = service.includes(".") ? service : `${service}.service`;
      checkAllow(t.allowedServices, service, "serviço", "SERVICE_NOT_ALLOWED");
      const T = await tr(t);
      const res = await T.exec(["journalctl", "-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"]);
      return {
        target: t.id,
        unit,
        requested_lines: lines,
        exit_code: res.code,
        truncated: res.truncated,
        note: journalAccessNote(res),
        output: redactText(res.stdout),
      };
    },
  },

  {
    name: "service_action",
    description: "Executa start/stop/restart/reload de serviço systemd allowlisted quando a ação também estiver liberada. A permissão do SO continua sendo obrigatória.",
    inputSchema: {
      target: targetField,
      service: z.string().min(1).max(100),
      action: z.enum(["start","stop","restart","reload"]),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireOperator(t);
      const service=assertIdentifier(String(args.service??""),"service");
      const unit=service.includes(".")?service:`${service}.service`;
      checkAllow(t.allowedServices,service,"serviço","SERVICE_NOT_ALLOWED");
      const action=requireNamedCapability(t.allowedServiceActions,args.action,"ação systemd");
      const T=await tr(t);
      const res=await T.exec(["systemctl",action,unit],{timeoutMs:t.commandTimeoutMs??30_000});
      if(res.code!==0) throw new OpsError("REMOTE_COMMAND_FAILED",`systemctl ${action} falhou (exit ${res.code})`,redactText(res.stderr).slice(0,300));
      return {target:t.id,unit,action,status:"ok",output:redactText(res.stdout)};
    },
  },

  // ============ git ============
  {
    name: "git_head",
    description: "Commit HEAD de um repositório git no target (hash, autor, data, mensagem).",
    inputSchema: {
      target: targetField,
      repository: z.string().min(1).max(256).describe("Caminho absoluto do repositório (ex.: /opt/wandora)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const repo = await resolveCheckedGitRepo(String(args.repository ?? ""), t, getTransport(t).exec);
      const T = await tr(t);
      const head = requireExec(await T.exec(["git", "-C", repo, "rev-parse", "HEAD"]), "git");
      const log = await T.exec(["git", "-C", repo, "log", "-1", "--format=%H%n%an%n%aI%n%s"]).catch(() => null);
      const logLines = (log?.stdout ?? "").split("\n");
      return {
        target: t.id,
        repository: repo,
        head: head.stdout.trim(),
        author: logLines[1] ?? null,
        date: logLines[2] ?? null,
        message: logLines[3] ?? null,
      };
    },
  },
  {
    name: "git_status",
    description: "Status do working tree (porcelain) de um repositório git no target.",
    inputSchema: {
      target: targetField,
      repository: z.string().min(1).max(256).describe("Caminho absoluto do repositório"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const repo = await resolveCheckedGitRepo(String(args.repository ?? ""), t, getTransport(t).exec);
      const T = await tr(t);
      const res = await T.exec(["git", "-C", repo, "-c", "core.quotepath=false", "status", "--porcelain=v1", "-b"]);
      return {
        target: t.id,
        repository: repo,
        exit_code: res.code,
        output: redactText(res.stdout || res.stderr),
      };
    },
  },
  {
    name: "git_diff_summary",
    description: "Resumo estatístico (diff --stat) do working tree de um repositório git no target.",
    inputSchema: {
      target: targetField,
      repository: z.string().min(1).max(256).describe("Caminho absoluto do repositório"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const repo = await resolveCheckedGitRepo(String(args.repository ?? ""), t, getTransport(t).exec);
      const T = await tr(t);
      const worktree = await T.exec(["git", "-C", repo, "diff", "--stat"]).catch(() => null);
      const staged = await T.exec(["git", "-C", repo, "diff", "--cached", "--stat"]).catch(() => null);
      return {
        target: t.id,
        repository: repo,
        working_tree: worktree ? redactText(worktree.stdout || worktree.stderr) : null,
        staged: staged ? redactText(staged.stdout || staged.stderr) : null,
      };
    },
  },

  // ============ filesystem ============
  {
    name: "list_directory",
    description: "Lista o conteúdo de um diretório dentro da allowlist do target (ls -la). Path traversal e symlinks externos são bloqueados.",
    inputSchema: {
      target: targetField,
      path: z.string().min(1).max(512).describe("Caminho absoluto dentro da allowlist (ex.: /opt/wandora)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const real = await resolveCheckedPath(String(args.path ?? ""), t, getTransport(t).exec);
      const T = await tr(t);
      const res = requireExec(await T.exec(["ls", "-la", "--time-style=long-iso", real]), "ls");
      return { target: t.id, path: real, listing: redactText(res.stdout), truncated: res.truncated };
    },
  },
  {
    name: "read_file",
    description:
      "Lê o início de um arquivo dentro da allowlist (máx 64KB e 400 linhas). Arquivos de segredos (.env, *.key, *.pem, credentials...) são SEMPRE negados.",
    inputSchema: {
      target: targetField,
      path: z.string().min(1).max(512).describe("Caminho absoluto do arquivo dentro da allowlist"),
      max_lines: z.coerce.number().int().min(1).max(400).optional().describe("Máximo de linhas (padrão 200, máx 400)"),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const maxLines = Math.min(Math.max(Number(args.max_lines ?? 200), 1), 400);
      const real = await resolveCheckedPath(String(args.path ?? ""), t, getTransport(t).exec);
      const T = await tr(t);
      const stat = await T.exec(["stat", "-c", "%s", real]);
      const size = Number(stat.stdout.trim()) || 0;
      const bytes = Math.min(size || env.READ_FILE_MAX_BYTES, env.READ_FILE_MAX_BYTES);
      const head = requireExec(await T.exec(["head", "-c", String(bytes), real]), "head");
      let content = head.stdout.split("\n").slice(0, maxLines).join("\n");
      const linesCut = head.stdout.split("\n").length > maxLines;
      return {
        target: t.id,
        path: real,
        size_bytes: size,
        returned_bytes: bytes,
        truncated_by_bytes: size > bytes || head.truncated,
        truncated_by_lines: linesCut,
        content: redactText(content),
      };
    },
  },

  // ============ execution MVP ============
  {
    name: "create_directory",
    description: "Cria um diretório dentro da workspace operacional allowlisted do target. Não usa sudo.",
    inputSchema: {
      target: targetField,
      path: z.string().min(1).max(1024),
    },
    mutation: true,
    destructive: false,
    idempotent: true,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      const targetPath = assertConfiguredPath(String(args.path ?? ""), t.allowedWritePaths, "escrita");
      return { target: t.id, ...(await agentJson(t, "workspace.mkdir", { path: targetPath })) };
    },
  },
  {
    name: "write_file",
    description: "Escreve ou acrescenta texto em arquivo dentro da workspace operacional allowlisted. Escrita atômica no modo rewrite; paths de segredo continuam bloqueados.",
    inputSchema: {
      target: targetField,
      path: z.string().min(1).max(1024),
      content: z.string().max(524288),
      mode: z.enum(["rewrite","append"]).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      const targetPath = assertConfiguredPath(String(args.path ?? ""), t.allowedWritePaths, "escrita");
      const content = String(args.content ?? "");
      const mode = args.mode === "append" ? "append" : "rewrite";
      return { target: t.id, ...(await agentJson(t, "workspace.write", { path: targetPath, content_b64: Buffer.from(content,"utf8").toString("base64"), mode }, 20_000)) };
    },
  },
  {
    name: "edit_file",
    description: "Faz substituição exata em arquivo da workspace operacional, exigindo a quantidade esperada de ocorrências.",
    inputSchema: {
      target: targetField,
      path: z.string().min(1).max(1024),
      old_string: z.string().min(1).max(262144),
      new_string: z.string().max(262144),
      expected_replacements: z.coerce.number().int().min(1).max(100).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      const targetPath = assertConfiguredPath(String(args.path ?? ""), t.allowedWritePaths, "escrita");
      const oldText = String(args.old_string ?? ""), newText = String(args.new_string ?? "");
      return { target: t.id, ...(await agentJson(t, "workspace.edit", {
        path: targetPath,
        old_b64: Buffer.from(oldText,"utf8").toString("base64"),
        new_b64: Buffer.from(newText,"utf8").toString("base64"),
        expected_replacements: Number(args.expected_replacements ?? 1),
      }, 20_000)) };
    },
  },
  {
    name: "move_file",
    description: "Move/renomeia arquivo ou diretório entre paths permitidos da workspace operacional.",
    inputSchema: {
      target: targetField,
      source: z.string().min(1).max(1024),
      destination: z.string().min(1).max(1024),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      const source = assertConfiguredPath(String(args.source ?? ""), t.allowedWritePaths, "escrita");
      const destination = assertConfiguredPath(String(args.destination ?? ""), t.allowedWritePaths, "escrita");
      return { target: t.id, ...(await agentJson(t, "workspace.move", { source, destination })) };
    },
  },
  {
    name: "start_process",
    description: "Inicia processo persistente no execution broker isolado. Não usa shell implícito; program e cwd precisam estar nas allowlists do target.",
    inputSchema: {
      target: targetField,
      cwd: z.string().min(1).max(1024),
      program: z.string().min(1).max(80),
      args: z.array(z.string().max(16384)).max(80).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      const cwd = await resolveCheckedProcessCwd(String(args.cwd ?? ""), t, getTransport(t).exec);
      const program = requireProgram(t, args.program);
      const argv = Array.isArray(args.args) ? args.args.map(String) : [];
      return { target: t.id, ...(await agentJson(t, "process.start", { cwd, program, argv })) };
    },
  },
  {
    name: "read_process_output",
    description: "Lê incrementalmente a saída de uma sessão iniciada por start_process.",
    inputSchema: {
      target: targetField,
      session_id: z.string().regex(/^ps_[a-f0-9]{24}$/),
      offset: z.coerce.number().int().min(0).optional(),
      max_chars: z.coerce.number().int().min(1).max(262144).optional(),
    },
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      return { target: t.id, ...(await agentJson(t, "process.read", { session_id:String(args.session_id), offset:Number(args.offset??0), max_chars:Number(args.max_chars??65536) })) };
    },
  },
  {
    name: "send_process_input",
    description: "Envia texto para stdin de uma sessão ativa do execution broker.",
    inputSchema: {
      target: targetField,
      session_id: z.string().regex(/^ps_[a-f0-9]{24}$/),
      input: z.string().max(65536),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireOperator(t);
      return { target:t.id, ...(await agentJson(t,"process.input",{session_id:String(args.session_id),input_b64:Buffer.from(String(args.input??""),"utf8").toString("base64")})) };
    },
  },
  {
    name: "kill_process",
    description: "Encerra uma sessão de processo criada pelo execution broker.",
    inputSchema: {
      target: targetField,
      session_id: z.string().regex(/^ps_[a-f0-9]{24}$/),
      signal: z.enum(["SIGTERM","SIGINT","SIGKILL"]).optional(),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireOperator(t);
      return { target:t.id, ...(await agentJson(t,"process.kill",{session_id:String(args.session_id),signal:String(args.signal??"SIGTERM")})) };
    },
  },
  {
    name: "list_processes",
    description: "Lista somente as sessões criadas no execution broker deste target.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t=resolveTarget(args.target);
      requireOperator(t);
      return { target:t.id, ...(await agentJson(t,"process.list")) };
    },
  },

  // ============ Portainer ============
  {
    name: "portainer_status",
    description: "Valida a conexão autenticada com a API do Portainer configurada no control plane e retorna somente status redigido. O token nunca é retornado.",
    inputSchema: {},
    run: async () => portainerStatus(),
  },
  {
    name: "portainer_endpoints_list",
    description: "Lista os ambientes/endpoints do Portainer necessários para criar e operar stacks. Não retorna credenciais nem URLs internas.",
    inputSchema: {},
    run: async () => portainerEndpoints(),
  },
  {
    name: "portainer_stacks_list",
    description: "Lista stacks gerenciadas pelo Portainer com metadados seguros. Valores de variáveis de ambiente são sempre redigidos.",
    inputSchema: {},
    run: async () => portainerStacks(),
  },
  {
    name: "portainer_stack_get",
    description: "Inspeciona uma stack do Portainer por ID. Valores de variáveis de ambiente e credenciais Git são sempre redigidos.",
    inputSchema: {
      stack_id: z.number().int().positive(),
    },
    run: async (args) => portainerStack(Number(args.stack_id)),
  },
  {
    name: "portainer_stack_start",
    description: "Inicia uma stack parada no Portainer. Exige stack_id e confirmação exata do nome da stack.",
    inputSchema: {
      stack_id: z.number().int().positive(),
      confirm_stack_name: z.string().min(1).max(120),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args) => startPortainerStack({
      stackId: Number(args.stack_id),
      confirmStackName: String(args.confirm_stack_name),
    }),
  },
  {
    name: "portainer_stack_stop",
    description: "Para uma stack no Portainer. Exige stack_id e confirmação exata do nome da stack.",
    inputSchema: {
      stack_id: z.number().int().positive(),
      confirm_stack_name: z.string().min(1).max(120),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => stopPortainerStack({
      stackId: Number(args.stack_id),
      confirmStackName: String(args.confirm_stack_name),
    }),
  },
  {
    name: "portainer_stack_delete",
    description: "Remove uma stack gerenciada pelo Portainer. Exige stack_id e confirmação exata do nome; volumes só são removidos quando remove_volumes=true.",
    inputSchema: {
      stack_id: z.number().int().positive(),
      confirm_stack_name: z.string().min(1).max(120),
      remove_volumes: z.boolean().default(false),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => deletePortainerStack({
      stackId: Number(args.stack_id),
      confirmStackName: String(args.confirm_stack_name),
      removeVolumes: args.remove_volumes === true,
    }),
  },
  {
    name: "portainer_stack_update_env",
    description: "Atualiza variáveis de ambiente de uma stack Portainer e faz redeploy preservando as demais variáveis por padrão. Para stacks Git usa o fluxo git/redeploy; para stacks Compose reenvia o stack file atual. Exige confirmação exata do nome da stack.",
    inputSchema: {
      stack_id: z.number().int().positive(),
      confirm_stack_name: z.string().min(1).max(120),
      changes: z.array(z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(160),
        value: z.string().max(32768),
      }).strict()).max(100).default([]),
      unset_names: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(160)).max(100).default([]),
      replace_all: z.boolean().default(false),
      pull_image: z.boolean().default(false),
      prune: z.boolean().default(false),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => {
      const changes = (args.changes ?? []) as Array<{name:string;value:string}>;
      const unsetNames = (args.unset_names ?? []) as string[];
      if (changes.length === 0 && unsetNames.length === 0 && args.replace_all !== true) {
        throw new OpsError("INVALID_ARGUMENT", "nenhuma alteração de variável foi solicitada");
      }
      return updatePortainerStackEnv({
        stackId: Number(args.stack_id),
        confirmStackName: String(args.confirm_stack_name),
        changes,
        unsetNames,
        replaceAll: args.replace_all === true,
        pullImage: args.pull_image === true,
        prune: args.prune === true,
      });
    },
  },
  {
    name: "portainer_stack_git_redeploy",
    description: "Faz Pull and redeploy de uma stack criada a partir de Git, preservando as variáveis atuais. Exige confirmação exata do nome da stack.",
    inputSchema: {
      stack_id: z.number().int().positive(),
      confirm_stack_name: z.string().min(1).max(120),
      pull_image: z.boolean().default(true),
      prune: z.boolean().default(false),
    },
    mutation: true,
    destructive: true,
    idempotent: false,
    run: async (args) => redeployPortainerGitStack({
      stackId: Number(args.stack_id),
      confirmStackName: String(args.confirm_stack_name),
      pullImage: args.pull_image !== false,
      prune: args.prune === true,
    }),
  },
  {
    name: "portainer_stack_create_git",
    description: "Cria no Portainer uma nova stack Docker Standalone a partir de um repositório Git público. As variáveis ficam gerenciáveis no Portainer. Não aceita credenciais Git nesta primeira versão.",
    inputSchema: {
      endpoint_id: z.number().int().positive(),
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
      confirm_stack_name: z.string().min(1).max(63),
      repository_url: z.string().url(),
      reference_name: z.string().min(1).max(240).default("refs/heads/main"),
      compose_file: z.string().min(1).max(240).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "compose_file deve ser relativo e sem .."),
      env: z.array(z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(160),
        value: z.string().max(32768),
      }).strict()).max(100).default([]),
    },
    mutation: true,
    destructive: false,
    idempotent: false,
    run: async (args) => {
      const name = String(args.name);
      if (String(args.confirm_stack_name) !== name) {
        throw new OpsError("INVALID_ARGUMENT", "confirm_stack_name deve ser exatamente igual a name");
      }
      return createPortainerGitStack({
        endpointId: Number(args.endpoint_id),
        name,
        repositoryUrl: String(args.repository_url),
        referenceName: String(args.reference_name ?? "refs/heads/main"),
        composeFile: String(args.compose_file),
        env: (args.env ?? []) as Array<{name:string;value:string}>,
      });
    },
  },

  // ============ OpenHands Agent Mesh (fixed local backend, opt-in capabilities) ============
  {
    name: "openhands_health",
    description: "Verifica a saúde do OpenHands na VPS Vigia, sem ler chave, sem iniciar agentes. Exige capability openhands.read.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      requireSemanticCapability(t,"openhands.read");
      return {target:t.id,...await agentJson(t,"openhands.health")};
    },
  },
  {
    name: "openhands_list",
    description: "Lista até 20 conversas OpenHands por página, expondo apenas id, título, status e horários. Exige openhands.read e chave no host.",
    inputSchema: {
      target:targetField,
      limit:z.number().int().min(1).max(20).default(10),
      page_id:z.string().min(1).max(256).optional(),
    },
    run:async(args)=>{
      const t=resolveTarget(args.target);
      requireSemanticCapability(t,"openhands.read");
      return {target:t.id,...await agentJson(t,"openhands.list",{limit:args.limit??10,page_id:args.page_id})};
    },
  },
  {
    name: "openhands_status",
    description: "Consulta estado resumido de uma conversa OpenHands pelo UUID; não devolve configurações ou segredos.",
    inputSchema: {target:targetField,conversation_id:z.string().uuid()},
    run:async(args)=>{
      const t=resolveTarget(args.target);
      requireSemanticCapability(t,"openhands.read");
      return {target:t.id,...await agentJson(t,"openhands.status",{conversation_id:args.conversation_id})};
    },
  },
  {
    name: "openhands_result",
    description: "Obtém somente a resposta final truncada a 4 mil caracteres; o resultado pode conter dados privados e deve ser tratado com cautela.",
    inputSchema: {target:targetField,conversation_id:z.string().uuid()},
    run:async(args)=>{
      const t=resolveTarget(args.target);
      requireSemanticCapability(t,"openhands.read");
      return {target:t.id,...await agentJson(t,"openhands.result",{conversation_id:args.conversation_id})};
    },
  },
  {
    name: "openhands_start",
    description: "INICIA tarefa OpenHands com custo de LLM, workspace isolado fixo, limite de 20 iterações e AlwaysConfirm. Só após pedido explícito do proprietário; exige semantic-operator + openhands.execute. NÃO autoriza merge, deploy nem uso de GitHub com escrita.",
    inputSchema: {
      target:targetField,
      task:z.string().trim().min(5).max(4000),
    },
    mutation:true,
    destructive:false,
    idempotent:false,
    run:async(args)=>{
      const t=resolveTarget(args.target);
      requireOpenHandsExecutor(t);
      return {target:t.id,...await agentJson(t,"openhands.start",{task:args.task},30000)};
    },
  },
  {
    name: "openhands_stop",
    description: "Pede interrupção de uma conversa OpenHands identificada por UUID; exige confirmação exata do ID, semantic-operator e openhands.execute.",
    inputSchema: {
      target:targetField,
      conversation_id:z.string().uuid(),
      confirm_conversation_id:z.string().uuid(),
    },
    mutation:true,
    destructive:true,
    idempotent:false,
    run:async(args)=>{
      if(args.conversation_id!==args.confirm_conversation_id) throw new OpsError("INVALID_ARGUMENT","confirmação do conversation_id diverge");
      const t=resolveTarget(args.target);
      requireOpenHandsExecutor(t);
      return {target:t.id,...await agentJson(t,"openhands.stop",{conversation_id:args.conversation_id},20000)};
    },
  },

  // ============ resumo ============
  {
    name: "runtime_summary",
    description: "Resumo operacional do target: disco raiz, memória, uptime e quantidade de contêineres rodando.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      const T = await tr(t);
      const [disk, mem, up, dockerPs] = await Promise.all([
        T.exec(["df", "-hP"]).catch(() => null),
        T.exec(["free", "-b"]).catch(() => null),
        T.exec(["uptime", "-p"]).catch(() => null),
        T.exec(["docker", "ps", "-q"]).catch(() => null),
      ]);
      let root: string | null = null;
      if (disk && disk.code === 0) {
        const line = disk.stdout.split("\n").find((l) => /\/$/.test(l.trim()));
        if (line) root = line.trim();
      }
      let memPct: number | null = null;
      if (mem && mem.code === 0) {
        const memLine = mem.stdout.split("\n").find((l) => l.startsWith("Mem:"));
        const cols = memLine ? memLine.split(/\s+/).slice(1).map(Number) : [];
        if (cols.length >= 3 && cols[0] > 0) memPct = Math.round((cols[1] / cols[0]) * 100);
      }
      return {
        target: t.id,
        disk_root: root,
        memory_used_pct: memPct,
        uptime: up?.stdout.trim() ?? null,
        docker_running: dockerPs?.code === 0 ? dockerPs.stdout.split("\n").filter((l) => l.trim()).length : null,
        notes: dockerPs?.code !== 0 ? "docker indisponível para este usuário" : undefined,
      };
    },
  },
];

// A semantic-only OpenHands target must not access unrelated MCP tools,
// including unscoped read helpers such as host_status or runtime_summary.
const OPENHANDS_SEMANTIC_TOOLS = new Set([
  "openhands_health", "openhands_list", "openhands_status",
  "openhands_result", "openhands_start", "openhands_stop",
]);
for (const tool of TOOL_DEFS) {
  const originalRun = tool.run;
  tool.run = async (args, ctx) => {
    if (typeof args.target === "string") {
      const target = getTarget(args.target);
      if (target?.capabilityProfile === "semantic-operator" && !OPENHANDS_SEMANTIC_TOOLS.has(tool.name)) {
        throw new OpsError("CAPABILITY_DENIED", "Target OpenHands semântico não autoriza esta ferramenta MCP");
      }
    }
    return originalRun(args, ctx);
  };
}

export { TOOL_DEFS };