import crypto from "node:crypto";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { redactText } from "../security/redact.js";
import { effectiveTargetEnabled } from "../state/store.js";
import {
  MANAGED_ADMIN_CAPABILITY,
  MANAGED_ADMIN_HARD_DENY,
  cwdLexicallyAllowed,
} from "../privileged/managed-admin-policy.js";
import { signManagedAdminTicket, type ManagedAdminTicketV1 } from "../privileged/managed-admin-ticket.js";
import {
  APPROVAL_TTL_MS,
  newApprovalId,
  requireApprovalConfirmation,
  requireLiveDevice,
} from "./approval-utils.js";
import { getTarget, type TargetConfig } from "./targets.js";

interface ManagedAdminAction {
  targetId: string;
  deviceId: string;
  program: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

interface PendingManagedAdminApproval {
  id: string;
  actor: string;
  createdAt: number;
  expiresAt: number;
  action: ManagedAdminAction;
  summary: string;
}

const approvals = new Map<string, PendingManagedAdminApproval>();
const TICKET_TTL_MS = 90_000;
const HARD_DENY = new Set<string>(MANAGED_ADMIN_HARD_DENY);

function purge(now = Date.now()): void {
  for (const [id, approval] of approvals) {
    if (approval.expiresAt < now) approvals.delete(id);
  }
}

function requireManagedAdminAuthSecret(): string {
  if (env.AUTH_MODE !== "oauth") {
    throw new OpsError("CAPABILITY_DENIED", "managed-admin é proibido quando AUTH_MODE não é oauth");
  }
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new OpsError("CAPABILITY_DENIED", "managed-admin requer AUTH_SECRET forte no control plane");
  }
  return secret;
}

function requireManagedAdminTarget(targetId: string): TargetConfig {
  const t = getTarget(targetId);
  if (!t) throw new OpsError("TARGET_NOT_FOUND", `target "${targetId}" não existe no registry`);
  if (!effectiveTargetEnabled(t.id, t.enabled)) {
    throw new OpsError("TARGET_DISABLED", `target "${targetId}" está desabilitado`);
  }
  if (t.transport !== "agent" || !t.deviceId) {
    throw new OpsError("CAPABILITY_DENIED", "managed-admin exige target Agent Mesh");
  }
  if (t.capabilityProfile !== "operator") {
    throw new OpsError("CAPABILITY_DENIED", "managed-admin exige capabilityProfile operator");
  }
  if (!t.allowedSemanticCapabilities.includes(MANAGED_ADMIN_CAPABILITY)) {
    throw new OpsError("CAPABILITY_DENIED", `target "${targetId}" não possui ${MANAGED_ADMIN_CAPABILITY}`);
  }
  return t;
}

function normalizeProgram(t: TargetConfig, value: unknown): string {
  const program = String(value ?? "");
  if (!/^[A-Za-z0-9_.+-]{1,80}$/.test(program)) {
    throw new OpsError("INVALID_ARGUMENT", "program administrativo inválido");
  }
  if (HARD_DENY.has(program)) {
    throw new OpsError("CAPABILITY_DENIED", `program administrativo "${program}" é hard-denied`);
  }
  if (!t.allowedAdminPrograms.includes(program)) {
    throw new OpsError("CAPABILITY_DENIED", `program administrativo "${program}" não está na allowlist do target`);
  }
  return program;
}

function normalizeArgv(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80) {
    throw new OpsError("INVALID_ARGUMENT", "argv administrativo inválido");
  }
  return value.map((item) => {
    const arg = String(item ?? "");
    if (Buffer.byteLength(arg, "utf8") > 16_384 || /[\0\r\n]/.test(arg)) {
      throw new OpsError("INVALID_ARGUMENT", "argumento administrativo inválido");
    }
    return arg;
  });
}

function normalizeCwd(t: TargetConfig, value: unknown): string {
  const cwd = String(value ?? "/opt/wandora/ops-workspace");
  if (!cwdLexicallyAllowed(cwd, t.allowedAdminCwds)) {
    throw new OpsError("CAPABILITY_DENIED", `cwd administrativo "${cwd}" fora da allowlist do target`);
  }
  return cwd;
}

function normalizeTimeout(value: unknown): number {
  const n = Number(value ?? 30_000);
  if (!Number.isInteger(n) || n < 1_000 || n > 120_000) {
    throw new OpsError("INVALID_ARGUMENT", "timeout_ms administrativo inválido");
  }
  return n;
}

function requireDeviceCapability(deviceId: string): void {
  const device = requireLiveDevice(deviceId);
  if (!device.capabilities?.includes(MANAGED_ADMIN_CAPABILITY)) {
    throw new OpsError("CAPABILITY_DENIED", `device "${deviceId}" não anunciou ${MANAGED_ADMIN_CAPABILITY}`);
  }
}

function actionSummary(action: ManagedAdminAction): string {
  const command = [action.program, ...action.argv]
    .map((item) => redactText(item))
    .map((item) => JSON.stringify(item))
    .join(" ");
  return `managed-admin ${action.targetId}: ${command}; cwd=${action.cwd}; timeout_ms=${action.timeoutMs}`;
}

export function prepareManagedAdminAction(input: {
  actor: string;
  targetId: string;
  program: unknown;
  argv?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
}) {
  purge();
  requireManagedAdminAuthSecret();
  const t = requireManagedAdminTarget(input.targetId);
  requireDeviceCapability(t.deviceId!);

  const action: ManagedAdminAction = {
    targetId: t.id,
    deviceId: t.deviceId!,
    program: normalizeProgram(t, input.program),
    argv: normalizeArgv(input.argv),
    cwd: normalizeCwd(t, input.cwd),
    timeoutMs: normalizeTimeout(input.timeoutMs),
  };

  const id = newApprovalId();
  const now = Date.now();
  const summary = actionSummary(action);
  approvals.set(id, {
    id,
    actor: input.actor,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    action,
    summary,
  });

  return {
    approval_id: id,
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    target_id: action.targetId,
    device_id: action.deviceId,
    program: action.program,
    argv_preview: action.argv.map((item) => redactText(item)),
    cwd: action.cwd,
    timeout_ms: action.timeoutMs,
    summary,
    required_confirmation: `APPROVE ${id}`,
    executed: false,
  };
}

export function consumeManagedAdminApproval(input: {
  actor: string;
  targetId: string;
  approvalId: string;
  confirmation: string;
}): {
  approvalId: string;
  target: TargetConfig;
  ticket: ManagedAdminTicketV1;
  signature: string;
  summary: string;
} {
  purge();
  const approval = approvals.get(input.approvalId);
  if (!approval) {
    throw new OpsError("INVALID_ARGUMENT", "aprovação managed-admin inexistente ou expirada");
  }
  if (approval.actor !== input.actor) {
    throw new OpsError("CAPABILITY_DENIED", "aprovação managed-admin pertence a outro ator MCP");
  }
  if (approval.action.targetId !== input.targetId) {
    throw new OpsError("CAPABILITY_DENIED", "target informado não corresponde à aprovação managed-admin");
  }
  requireApprovalConfirmation(approval.id, input.confirmation);

  const secret = requireManagedAdminAuthSecret();
  const t = requireManagedAdminTarget(approval.action.targetId);
  if (t.deviceId !== approval.action.deviceId) {
    throw new OpsError("CAPABILITY_DENIED", "device do target mudou após a preparação");
  }
  requireDeviceCapability(approval.action.deviceId);

  const program = normalizeProgram(t, approval.action.program);
  const argv = normalizeArgv(approval.action.argv);
  const cwd = normalizeCwd(t, approval.action.cwd);
  const timeoutMs = normalizeTimeout(approval.action.timeoutMs);

  approvals.delete(approval.id);
  const now = Date.now();
  const ticket: ManagedAdminTicketV1 = {
    v: 1,
    target_id: approval.action.targetId,
    device_id: approval.action.deviceId,
    program,
    argv,
    cwd,
    timeout_ms: timeoutMs,
    nonce: crypto.randomBytes(24).toString("hex"),
    issued_at: now,
    expires_at: now + TICKET_TTL_MS,
  };

  return {
    approvalId: approval.id,
    target: t,
    ticket,
    signature: signManagedAdminTicket(ticket, secret),
    summary: approval.summary,
  };
}
