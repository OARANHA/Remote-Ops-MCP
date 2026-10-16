import { OpsError } from "../lib/errors.js";
import { getTarget, upsertDynamicAgentTarget } from "./targets.js";
import { APPROVAL_TTL_MS, newApprovalId, requireApprovalConfirmation, requireLiveDevice } from "./approval-utils.js";

const TARGET = "deepharness-read";
const CONTAINERS = Object.freeze(["deepharness-web-1", "deepharness-mcp-grants-db-1"]);
const pending = new Map<string, { actor: string; expires: number; deviceId: string }>();

function baseline() {
  const t = getTarget(TARGET);
  if (!t || t.transport !== "agent" || t.capabilityProfile !== "read-only" ||
      !t.enabled || !t.deviceId || t.environment !== "production") {
    throw new OpsError("CAPABILITY_DENIED", "DeepHarness read-only target unavailable");
  }
  if (t.allowedDockerExecContainers.length || t.allowedDockerExecPrograms.length ||
      t.allowedDockerActions.length || t.allowedWritePaths.length ||
      t.allowedProcessPrograms.length || t.allowedAdminPrograms.length ||
      t.allowedSemanticCapabilities.length) {
    throw new OpsError("CAPABILITY_DENIED", "DeepHarness target has unexpected authority");
  }
  if (t.allowedDockerContainers.some(c => !CONTAINERS.includes(c))) {
    throw new OpsError("CAPABILITY_DENIED", "Unexpected Docker target entry");
  }
  requireLiveDevice(t.deviceId);
  return t;
}

export function prepareDeepharnessDockerRead(actor: string) {
  const t = baseline();
  const now = Date.now();
  for (const [id, p] of pending) if (p.expires < now) pending.delete(id);
  const id = newApprovalId();
  const expires = now + APPROVAL_TTL_MS;
  pending.set(id, { actor, expires, deviceId: t.deviceId! });
  return {
    approval_id: id,
    expires_at: new Date(expires).toISOString(),
    target_id: TARGET,
    allowed_docker_containers: [...CONTAINERS],
    docker_exec: false,
    docker_mutations: false,
    host_proxy_update_required: true,
    required_confirmation: `APPROVE ${id}`,
    applied: false,
  };
}

export function applyDeepharnessDockerRead(actor: string, id: string, confirmation: string) {
  const p = pending.get(id);
  if (!p || p.expires < Date.now()) {
    pending.delete(id);
    throw new OpsError("INVALID_ARGUMENT", "Approval expired or missing");
  }
  if (actor !== p.actor) throw new OpsError("CAPABILITY_DENIED", "Approval belongs to another actor");
  requireApprovalConfirmation(id, confirmation);
  const t = baseline();
  if (t.deviceId !== p.deviceId) throw new OpsError("CAPABILITY_DENIED", "Device binding changed");
  const next = { ...t, allowedDockerContainers: [...CONTAINERS] };
  upsertDynamicAgentTarget(next);
  pending.delete(id);
  return {
    applied: true,
    target_id: TARGET,
    allowed_docker_containers: [...CONTAINERS],
    host_proxy_update_required: true,
    summary: "Target read allowlist updated; host-local Docker proxy must independently allow these containers",
  };
}
