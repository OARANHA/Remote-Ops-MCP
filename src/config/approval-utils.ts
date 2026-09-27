import crypto from "node:crypto";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { listDevices, type StoredDevice } from "../state/store.js";

export const APPROVAL_TTL_MS = 10 * 60_000;

export function newApprovalId(): string {
  return "adm_" + crypto.randomBytes(12).toString("hex");
}

export function requireLiveDevice(deviceId: string, now = Date.now()): StoredDevice {
  const device = listDevices().find((d) => d.device_id === deviceId);
  if (!device || device.revoked_at) {
    throw new OpsError("INVALID_ARGUMENT", `Agent Mesh device "${deviceId}" não existe ou está revogado`);
  }
  const staleMs = env.AGENT_HEARTBEAT_STALE_SECONDS * 2 * 1000;
  if (!device.last_seen_at || now - device.last_seen_at > staleMs) {
    throw new OpsError("REMOTE_COMMAND_FAILED", `Agent Mesh device "${deviceId}" não está online/recentemente ativo`);
  }
  return device;
}

export function requireApprovalConfirmation(id: string, confirmation: string): void {
  if (confirmation.trim() !== `APPROVE ${id}`) {
    throw new OpsError("CAPABILITY_DENIED", `confirmação inválida; esperado: APPROVE ${id}`);
  }
}
