import { z, type ZodRawShape } from "zod";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { assertIdentifier } from "../lib/quote.js";
import { getTarget, listTargets, publicTarget, targetIds } from "../config/targets.js";
import type { TargetConfig } from "../config/targets.js";
import { getTransport } from "../transport.js";
import { resolveCheckedGitRepo, resolveCheckedPath } from "../security/paths.js";
import { redactText, redactObject } from "../security/redact.js";
import type { ExecResult } from "../ssh/pool.js";
import { effectiveTargetEnabled } from "../state/store.js";

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

// ---------- tools ----------

const targetField = z
  .string()
  .min(1)
  .max(64)
  .describe("ID do target no Target Registry (ex.: wandora-prod). Use targets_list para ver os IDs.");

const TOOL_DEFS: ToolDef[] = [
  // ============ servidor ============
  {
    name: "health",
    description: "Status do servidor MCP (não acessa nenhuma VPS): versão, modo de auth, modo ensaio, quantidade de targets.",
    inputSchema: {},
    run: async () => ({
      status: "ok",
      service: "remote-ops-mcp",
      version: "1.1.0",
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
    description: "Detalhes de configuração de um target do registry (perfil de capability, allowlists). Não conecta na VPS.",
    inputSchema: { target: targetField },
    run: async (args) => {
      const t = resolveTarget(args.target);
      return publicTarget(t);
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

export { TOOL_DEFS };