import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { MANAGED_ADMIN_CAPABILITY } from "../privileged/managed-admin-policy.js";
import { buildAgentTargetFromPreset, describeTargetCapabilityBaseline, type AgentTargetPreset } from "./capability-baseline.js";
import { APPROVAL_TTL_MS, newApprovalId, requireApprovalConfirmation, requireLiveDevice } from "./approval-utils.js";
import { publicTarget, upsertDynamicAgentTarget, type TargetConfig } from "./targets.js";

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
