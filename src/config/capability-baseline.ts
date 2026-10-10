import { MANAGED_ADMIN_CAPABILITY, MANAGED_ADMIN_DEFAULT_CWDS, MANAGED_ADMIN_DEFAULT_PROGRAMS } from "../privileged/managed-admin-policy.js";
import type { TargetConfig } from "./targets.js";

export type AgentTargetPreset = "operator-workspace" | "read-only" | "openhands-read" | "postgres-readback" | "managed-admin";

export const AGENT_WORKSPACE_ROOT = "/opt/wandora/ops-workspace";

export const OPERATOR_WORKSPACE_PROGRAMS = [
  "bash","sh","git","node","npm","npx","pnpm","python3",
  "curl","wget","jq","grep","sed","awk","find","head","tail","cat","wc","make",
] as const;

const AUTHORITY_KEYS = [
  "capabilityProfile",
  "allowedPaths",
  "allowedDockerContainers",
  "allowedDockerExecContainers",
  "allowedDockerExecPrograms",
  "allowedDockerActions",
  "allowedDockerImageLoadRoots",
  "allowedDockerCandidateImagePrefixes",
  "allowedDockerCandidateNetworks",
  "allowedDockerCandidateNamePrefixes",
  "allowedDockerCandidateHostPorts",
  "allowedDockerCandidateContainerPorts",
  "allowedServices",
  "allowedServiceActions",
  "allowedGitRepos",
  "allowedSemanticCapabilities",
  "allowedAdminPrograms",
  "allowedAdminCwds",
  "allowedWritePaths",
  "allowedProcessCwds",
  "allowedProcessPrograms",
] as const satisfies readonly (keyof TargetConfig)[];

export function buildAgentTargetFromPreset(input: {
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
      allowedPaths: [AGENT_WORKSPACE_ROOT],
      allowedServices: ["wandora-ops-agent.service", "wandora-ops-exec-broker.service", "wandora-ops-admin-broker.service"],
      allowedServiceActions: ["restart"],
      allowedWritePaths: [AGENT_WORKSPACE_ROOT],
      allowedProcessCwds: [AGENT_WORKSPACE_ROOT],
      allowedProcessPrograms: [...OPERATOR_WORKSPACE_PROGRAMS],
      allowedSemanticCapabilities: [MANAGED_ADMIN_CAPABILITY],
      allowedAdminPrograms: [...MANAGED_ADMIN_DEFAULT_PROGRAMS],
      allowedAdminCwds: [...MANAGED_ADMIN_DEFAULT_CWDS],
    };
  }

  if (input.preset === "openhands-read") {
    return {
      ...base,
      capabilityProfile: "read-only",
      allowedPaths: [],
      allowedServices: [],
      allowedServiceActions: [],
      allowedWritePaths: [],
      allowedProcessCwds: [],
      allowedProcessPrograms: [],
      allowedSemanticCapabilities: ["openhands.read"],
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
      allowedPaths: [AGENT_WORKSPACE_ROOT],
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
    allowedPaths: [AGENT_WORKSPACE_ROOT],
    allowedServices: ["wandora-ops-agent.service", "wandora-ops-exec-broker.service"],
    allowedServiceActions: ["restart"],
    allowedWritePaths: [AGENT_WORKSPACE_ROOT],
    allowedProcessCwds: [AGENT_WORKSPACE_ROOT],
    allowedProcessPrograms: [...OPERATOR_WORKSPACE_PROGRAMS],
  };
}

export function describeTargetCapabilityBaseline(target: TargetConfig) {
  return {
    authority_class: target.capabilityProfile,
    transport: target.transport,
    workspace_read_roots: target.allowedPaths.length,
    workspace_write_roots: target.allowedWritePaths.length,
    process_cwd_roots: target.allowedProcessCwds.length,
    process_programs: target.allowedProcessPrograms.length,
    docker_read_containers: target.allowedDockerContainers.length,
    docker_exec_containers: target.allowedDockerExecContainers.length,
    docker_actions: target.allowedDockerActions.length,
    service_units: target.allowedServices.length,
    service_actions: target.allowedServiceActions.length,
    semantic_capabilities: target.allowedSemanticCapabilities.length,
    managed_admin: target.allowedSemanticCapabilities.includes(MANAGED_ADMIN_CAPABILITY),
    admin_programs: target.allowedAdminPrograms.length,
    admin_cwd_roots: target.allowedAdminCwds.length,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify([...value].sort((a,b)=>String(a).localeCompare(String(b))));
  }
  return JSON.stringify(value);
}

export function validateAgentTargetAgainstPreset(target: TargetConfig, preset: AgentTargetPreset) {
  if (target.transport !== "agent" || !target.deviceId) {
    return {
      preset,
      valid: false,
      differences: ["transport/deviceId"],
      capability_baseline: describeTargetCapabilityBaseline(target),
    };
  }

  const expected = buildAgentTargetFromPreset({
    targetId: target.id,
    deviceId: target.deviceId,
    environment: target.environment,
    preset,
  });

  const differences = AUTHORITY_KEYS
    .filter((key) => stable(target[key]) !== stable(expected[key]))
    .map(String);

  return {
    preset,
    valid: differences.length === 0,
    differences,
    capability_baseline: describeTargetCapabilityBaseline(target),
  };
}
