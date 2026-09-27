import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { MANAGED_ADMIN_CAPABILITY, MANAGED_ADMIN_DEFAULT_CWDS, MANAGED_ADMIN_DEFAULT_PROGRAMS } from "../privileged/managed-admin-policy.js";
import { APPROVAL_TTL_MS, newApprovalId, requireApprovalConfirmation, requireLiveDevice } from "./approval-utils.js";
import { publicTarget, upsertDynamicAgentTarget, type TargetConfig } from "./targets.js";

type AgentTargetPreset = "operator-workspace" | "read-only" | "postgres-readback" | "managed-admin";

interface PendingApproval {
  id: string;
  actor: string;
  createdAt: number;
  expiresAt: number;
  target: TargetConfig;
  summary: string;
}

const approvals = new Map<string, PendingApproval>();
const WORKSPACE = "/opt/wandora/ops-workspace";
const OPERATOR_PROGRAMS = [
  "bash","sh","git","node","npm","npx","pnpm","python3",
  "curl","wget","jq","grep","sed","awk","find","head","tail","cat","wc","make"
];

function purge(now = Date.now()): void {
  for (const [id, approval] of approvals) {
    if (approval.expiresAt < now) approvals.delete(id);
  }
}

function buildTarget(input: {
  targetId: string;
  deviceId: string;
  environment: "production" | "staging" | "development";
  preset: AgentTargetPreset;
}): TargetConfig {
  const base = {
    id: input.targetId,
    deviceId: input.deviceId,
    environment: input.environment,
    transport: "agent" as const,
    enabled: true,
    host: "127.0.0.1",
    port: 22,
    username: "ops-mcp",
    credentialRef: undefined,
    keyFile: undefined,
    hostKeyFingerprint: undefined,
    hostKey: undefined,
    allowedDockerContainers: [] as string[],
    allowedDockerExecContainers: [] as string[],
    allowedDockerExecPrograms: [] as string[],
    allowedDockerActions: [] as Array<"start"|"stop"|"restart"|"load_image"|"candidate_run"|"candidate_remove">,
    allowedDockerImageLoadRoots: [] as string[],
    allowedDockerCandidateImagePrefixes: [] as string[],
    allowedDockerCandidateNetworks: [] as string[],
    allowedDockerCandidateNamePrefixes: [] as string[],
    allowedDockerCandidateHostPorts: [] as number[],
    allowedDockerCandidateContainerPorts: [] as number[],
    allowedGitRepos: [] as string[],
    allowedSemanticCapabilities: [] as string[],
    allowedAdminPrograms: [] as string[],
    allowedAdminCwds: [] as string[],
  };

  if (input.preset === "managed-admin") {
    return {
      ...base,
      capabilityProfile: "operator",
      allowedPaths: [WORKSPACE],
      allowedServices: ["wandora-ops-agent.service", "wandora-ops-exec-broker.service", "wandora-ops-admin-broker.service"],
      allowedServiceActions: ["restart"],
      allowedWritePaths: [WORKSPACE],
      allowedProcessCwds: [WORKSPACE],
      allowedProcessPrograms: [...OPERATOR_PROGRAMS],
      allowedSemanticCapabilities: [MANAGED_ADMIN_CAPABILITY],
      allowedAdminPrograms: [...MANAGED_ADMIN_DEFAULT_PROGRAMS],
      allowedAdminCwds: [...MANAGED_ADMIN_DEFAULT_CWDS],
    };
  }

  if (input.preset === "postgres-readback") {
    return {
      ...base,
      capabilityProfile: "read-only",
      allowedPaths: [],
      allowedServices: [],
      allowedServiceActions: [],
      allowedWritePaths: [],
      allowedProcessCwds: [],
      allowedProcessPrograms: [],
      allowedSemanticCapabilities: ["postgres.pinned_readback"],
    };
  }

  if (input.preset === "read-only") {
    return {
      ...base,
      capabilityProfile: "read-only",
      allowedPaths: [WORKSPACE],
      allowedServices: ["wandora-ops-agent.service", "wandora-ops-exec-broker.service"],
      allowedServiceActions: [],
      allowedWritePaths: [],
      allowedProcessCwds: [],
      allowedProcessPrograms: [],
    };
  }

  return {
    ...base,
    capabilityProfile: "operator",
    allowedPaths: [WORKSPACE],
    allowedServices: ["wandora-ops-agent.service", "wandora-ops-exec-broker.service"],
    allowedServiceActions: ["restart"],
    allowedWritePaths: [WORKSPACE],
    allowedProcessCwds: [WORKSPACE],
    allowedProcessPrograms: [...OPERATOR_PROGRAMS],
  };
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
  const target = buildTarget(input);
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
    summary: approval.summary,
  };
}
