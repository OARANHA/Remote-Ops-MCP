import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { MANAGED_ADMIN_CAPABILITY } from "../privileged/managed-admin-policy.js";
import { buildAgentTargetFromPreset, describeTargetCapabilityBaseline, type AgentTargetPreset } from "./capability-baseline.js";
import { APPROVAL_TTL_MS, newApprovalId, requireApprovalConfirmation, requireLiveDevice } from "./approval-utils.js";
import { publicTarget, upsertDynamicAgentTarget, listTargets, type TargetConfig } from "./targets.js";
import { LAB_CAPABILITY, LAB_TARGET_ID } from "../docker/vigiafast-offline-probe.js";

interface PendingApproval {
  id: string;
  actor: string;
  createdAt: number;
  expiresAt: number;
  target: TargetConfig;
  summary: string;
}

const approvals = new Map<string, PendingApproval>();
function purge(now = Date.now()): void {
  for (const [id, approval] of approvals) {
    if (approval.expiresAt < now) approvals.delete(id);
  }
}

export function prepareAgentTarget(input: {
  actor: string;
  targetId: string;
  deviceId: string;
  environment: "production" | "staging" | "development";
  preset: AgentTargetPreset;
}) {
  purge();
  if (input.preset === "managed-admin" && (env.AUTH_MODE !== "oauth" || !env.AUTH_SECRET || env.AUTH_SECRET.length < 32)) {
    throw new OpsError("CAPABILITY_DENIED", "managed-admin exige AUTH_MODE=oauth e AUTH_SECRET forte");
  }
  const device = requireLiveDevice(input.deviceId);
  if (input.targetId === LAB_TARGET_ID && input.preset !== "vigiafast-dsh-offline") {
    throw new OpsError("CAPABILITY_DENIED", "identificador do laboratorio reservado ao preset governado");
  }
  if (input.targetId !== LAB_TARGET_ID && listTargets().some((t) => t.id === LAB_TARGET_ID && t.deviceId === input.deviceId)) {
    throw new OpsError("CAPABILITY_DENIED", "device do laboratorio nao pode ser reutilizado");
  }
  if (input.preset === "vigiafast-dsh-offline") {
    if (input.targetId !== LAB_TARGET_ID || input.environment !== "development") {
      throw new OpsError("CAPABILITY_DENIED", "laboratorio exige target exato de desenvolvimento");
    }
    if (listTargets().some((t) => t.deviceId === input.deviceId && t.id !== input.targetId)) {
      throw new OpsError("CAPABILITY_DENIED", "laboratorio exige device Agent Mesh exclusivo");
    }
    if (!device.capabilities?.includes(LAB_CAPABILITY)) {
      throw new OpsError("CAPABILITY_DENIED", "device do laboratorio nao anunciou capability offline explicitamente");
    }
  }
  const target = buildAgentTargetFromPreset(input);
  if (input.preset === "managed-admin" && !device.capabilities?.includes(MANAGED_ADMIN_CAPABILITY)) {
    throw new OpsError("CAPABILITY_DENIED", `Agent Mesh device "${input.deviceId}" não anunciou ${MANAGED_ADMIN_CAPABILITY}; instale/ative o broker managed-admin primeiro`);
  }
  const id = newApprovalId();
  const now = Date.now();
  const authority =
    input.preset === "postgres-readback"
      ? "pinned PostgreSQL readback only; generic Docker/process/write access remains disabled"
      : input.preset === "managed-admin"
        ? "workspace operator + signed managed-admin root broker; no generic sudo/docker group and no break-glass shell"
        : input.preset === "vigiafast-dsh-offline"
          ? "VIGIAFAST development-only offline probe semantic capability; no workspace, process, Docker, service or admin rights"
          : "static targets are not modified; Docker access remains disabled";
  const summary =
    `create/update dynamic target ${target.id} -> ${input.deviceId} (${input.environment}, ${input.preset}); ` +
    authority;

  approvals.set(id, {
    id,
    actor: input.actor,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    target,
    summary,
  });

  return {
    approval_id: id,
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    target_id: target.id,
    device_id: input.deviceId,
    device_name: device.display_name,
    preset: input.preset,
    summary,
    capability_baseline: describeTargetCapabilityBaseline(target),
    required_confirmation: `APPROVE ${id}`,
    applied: false,
  };
}

export function applyAgentTargetApproval(input: {
  actor: string;
  approvalId: string;
  confirmation: string;
}) {
  purge();
  const approval = approvals.get(input.approvalId);
  if (!approval) throw new OpsError("INVALID_ARGUMENT", "aprovação inexistente ou expirada");
  if (approval.actor !== input.actor) {
    throw new OpsError("CAPABILITY_DENIED", "aprovação pertence a outro ator MCP");
  }
  requireApprovalConfirmation(approval.id, input.confirmation);

  const liveDevice = requireLiveDevice(approval.target.deviceId!);
  if (approval.target.id !== LAB_TARGET_ID
      && listTargets().some((t) => t.id === LAB_TARGET_ID && t.deviceId === approval.target.deviceId)) {
    throw new OpsError("CAPABILITY_DENIED", "device do laboratorio nao pode ser reutilizado");
  }
  if (approval.target.id === LAB_TARGET_ID) {
    if (!liveDevice.capabilities?.includes(LAB_CAPABILITY)) {
      throw new OpsError("CAPABILITY_DENIED", "device do laboratorio deixou de anunciar capability offline");
    }
    if (approval.target.environment !== "development"
        || listTargets().some((t) => t.id !== LAB_TARGET_ID && t.deviceId === approval.target.deviceId)) {
      throw new OpsError("CAPABILITY_DENIED", "device do laboratorio nao e exclusivo ou ambiente e invalido");
    }
  }
  if (approval.target.allowedSemanticCapabilities.includes(MANAGED_ADMIN_CAPABILITY) && !liveDevice.capabilities?.includes(MANAGED_ADMIN_CAPABILITY)) {
    throw new OpsError("CAPABILITY_DENIED", `Agent Mesh device "${approval.target.deviceId}" deixou de anunciar ${MANAGED_ADMIN_CAPABILITY}`);
  }
  const result = upsertDynamicAgentTarget(approval.target);
  approvals.delete(approval.id);

  return {
    approval_id: approval.id,
    applied: true,
    target: publicTarget(result),
    capability_baseline: describeTargetCapabilityBaseline(result),
    summary: approval.summary,
  };
}
