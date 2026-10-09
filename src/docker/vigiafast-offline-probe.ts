/**
 * A one-shot, image-pinned OFFLINE attestation contract.
 * This is a deliberately separate capability from generic Docker candidates.
 * Does not authorize running any model, shell or repository checkout.
 */
export const LAB_TARGET_ID = "vigiafast-dsh-lab";
export const LAB_CAPABILITY = "vigiafast.dsh.offline_probe";
export const LAB_NAME = "vigiafast-dsh-offline-probe";
export const REQUIRED_CHECKS = [
  "linux",
  "unprivileged_uid",
  "no_linux_caps",
  "no_new_privileges",
  "loopback_only",
  "no_docker_socket",
  "no_provider_secret",
  "dedicated_home",
  "telemetry_disabled",
  "read_only_root",
  "writable_ephemeral_tmpfs",
] as const;

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export function validateLabImage(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_ID.test(value)) throw new Error("offline_lab_image_not_configured");
  return value;
}

/** No mounts, no host network, no host ports, no docker socket, no user arguments. */
export function offlineLabCreateRequest(image: string): Record<string, unknown> {
  validateLabImage(image);
  return {
    Image: image,
    User: "10001:10001",
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: false,
    NetworkDisabled: true,
    Env: [
      "HOME=/tmp",
      "DSH_TELEMETRY_DISABLED=1",
      "NODE_OPTIONS=--max-old-space-size=128",
    ],
    HostConfig: {
      NetworkMode: "none",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
      Init: true,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      PortBindings: {},
      Binds: [],
      Mounts: [],
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=16777216,uid=10001,gid=10001",
      },
    },
  };
}

export interface LabAttestation {
  type: "offline_lab_attestation";
  ok: boolean;
  checks: Record<string, boolean>;
}

/** Whitelist-only projection. All other fields, log lines and stderr are dropped. */
export function parseLabAttestation(value: unknown, exitCode: number): LabAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_lab_attestation");
  const obj = value as Record<string, unknown>;
  if (obj.type !== "offline_lab_attestation" || typeof obj.ok !== "boolean") throw new Error("invalid_lab_attestation");
  const data = obj.checks;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_lab_checks");
  const checks = data as Record<string, unknown>;
  if (Object.keys(checks).length !== REQUIRED_CHECKS.length
    || Object.keys(checks).some((k) => !REQUIRED_CHECKS.includes(k as typeof REQUIRED_CHECKS[number]))) throw new Error("unexpected_lab_check");
  const sanitized: Record<string, boolean> = {};
  for (const key of REQUIRED_CHECKS) {
    if (typeof checks[key] !== "boolean") throw new Error("missing_lab_check");
    // The ordinary MCP output redactor correctly hides fields named
    // "secret". Rename this boolean attestation key without leaking the
    // field or weakening the global redactor.
    sanitized[key === "no_provider_secret" ? "no_provider_material" : key] = checks[key] as boolean;
  }
  // Explicitly disallow probe claims that disagree with the actual exit code.
  if (obj.ok !== Object.values(sanitized).every(Boolean)) throw new Error("inconsistent_lab_checks");
  return { type: "offline_lab_attestation", ok: obj.ok && exitCode === 0, checks: sanitized };
}
