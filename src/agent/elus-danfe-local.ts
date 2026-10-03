import fs from "node:fs";
import https from "node:https";
import {
  ELUS_DANFE_CANARY_CANDIDATE_NAME,
  ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE,
  ELUS_DANFE_CANARY_NETWORK,
  ELUS_DANFE_CANARY_RECEIPT_NAME,
  ELUS_DANFE_CANARY_SEALED_ENV,
  ELUS_DANFE_CANARY_SOURCE_CONTAINER,
  ELUS_DANFE_CANARY_STACK_NAME,
  normalizeElusDanfeCanaryPayload,
  parseElusDanfeCanaryConfig,
  type ElusDanfeCanaryConfig,
} from "../docker/elus-danfe-canary.js";
import {
  executeElusDanfeCanaryOnce,
  type DockerSemanticResponse,
  type ElusDanfeCanaryDockerClient,
  type ElusDanfeCanaryExecution,
} from "../docker/elus-danfe-canary-runtime.js";

const LOCAL_PORTAINER_HOST = "127.0.0.1";
const LOCAL_PORTAINER_PORT = 9443;

interface LocalElusStack {
  id: number;
  endpointId: number;
  active: boolean;
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function localPortainerKey(): string {
  const stat = fs.lstatSync(ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE);
  const expectedUid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && stat.uid !== expectedUid)
  ) {
    throw new Error("local_portainer_api_key_permissions_invalid");
  }

  const raw = fs.readFileSync(ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE, "utf8").trim();
  if (!raw || raw.length < 16 || raw.length > 4096 || /[\r\n\0]/.test(raw)) {
    throw new Error("local_portainer_api_key_invalid");
  }
  return raw;
}

function canonicalConfig(raw: unknown): ElusDanfeCanaryConfig {
  const x = asRecord(raw, "invalid_elus_canary_config");
  const config = parseElusDanfeCanaryConfig({
    sourceContainer: String(x.sourceContainer ?? ""),
    image: String(x.image ?? ""),
    revision: String(x.revision ?? ""),
    candidateName: String(x.candidateName ?? ""),
    receiptName: String(x.receiptName ?? ""),
    network: String(x.network ?? ""),
  });
  if (!config) throw new Error("elus_canary_not_configured");

  if (
    config.sourceContainer !== ELUS_DANFE_CANARY_SOURCE_CONTAINER ||
    config.candidateName !== ELUS_DANFE_CANARY_CANDIDATE_NAME ||
    config.receiptName !== ELUS_DANFE_CANARY_RECEIPT_NAME ||
    config.network !== ELUS_DANFE_CANARY_NETWORK
  ) {
    throw new Error("elus_canary_local_boundary_mismatch");
  }

  return config;
}

async function localPortainerRequest(
  method: string,
  path: string,
  body?: Buffer,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<DockerSemanticResponse> {
  if (!path.startsWith("/") || /[\r\n\0]/.test(path) || path.length > 4096) {
    throw new Error("invalid_local_portainer_path");
  }

  const apiKey = localPortainerKey();
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const maxBytes = options?.maxBytes ?? 4 * 1024 * 1024;

  return await new Promise<DockerSemanticResponse>((resolve, reject) => {
    const req = https.request(
      {
        host: LOCAL_PORTAINER_HOST,
        port: LOCAL_PORTAINER_PORT,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          "X-API-Key": apiKey,
          ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;

        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error("local_portainer_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error("local_portainer_timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resolveElusStack(): Promise<LocalElusStack> {
  const response = await localPortainerRequest("GET", "/api/stacks", undefined, {
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  });
  if (response.status !== 200) throw new Error("elus_stack_discovery_failed");

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new Error("invalid_elus_stack_list");
  }
  if (!Array.isArray(parsed)) throw new Error("invalid_elus_stack_list");

  const matches = parsed
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    )
    .filter((item) => String(item.Name ?? "") === ELUS_DANFE_CANARY_STACK_NAME);

  if (matches.length === 0) throw new Error("elus_stack_unavailable");
  if (matches.length !== 1) throw new Error("elus_stack_ambiguous");

  const stack = matches[0]!;
  const id = Number(stack.Id);
  const endpointId = Number(stack.EndpointId);

  if (
    !Number.isInteger(id) ||
    id < 1 ||
    !Number.isInteger(endpointId) ||
    endpointId < 1
  ) {
    throw new Error("invalid_elus_stack_identity");
  }

  return {
    id,
    endpointId,
    active: Number(stack.Status) === 1,
  };
}

function dockerClient(endpointId: number): ElusDanfeCanaryDockerClient {
  return {
    request(method, path, body, options) {
      return localPortainerRequest(
        method,
        "/api/endpoints/" + String(endpointId) + "/docker" + path,
        body,
        options,
      );
    },
  };
}

async function inspectContainer(
  docker: ElusDanfeCanaryDockerClient,
  name: string,
): Promise<Record<string, unknown> | null> {
  const response = await docker.request(
    "GET",
    "/containers/" + encodeURIComponent(name) + "/json",
  );

  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error("local_portainer_container_inspect_failed");
  }

  try {
    return asRecord(
      JSON.parse(response.body.toString("utf8")),
      "invalid_local_container_inspect",
    );
  } catch {
    throw new Error("invalid_local_container_inspect");
  }
}

function running(inspect: Record<string, unknown> | null): boolean {
  if (!inspect) return false;
  const state = inspect.State;
  return (
    !!state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    (state as Record<string, unknown>).Running === true
  );
}

function sealedEnvComplete(inspect: Record<string, unknown> | null): boolean {
  if (!inspect) return false;

  const config = inspect.Config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;

  const env = (config as Record<string, unknown>).Env;
  if (!Array.isArray(env)) return false;

  const values = new Map<string, string>();
  for (const item of env) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    values.set(item.slice(0, eq), item.slice(eq + 1));
  }

  return ELUS_DANFE_CANARY_SEALED_ENV.every(
    (name) => (values.get(name) ?? "").trim().length > 0,
  );
}

export async function preflightElusDanfeCanaryAgent(
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config = canonicalConfig(raw.config);
  const stack = await resolveElusStack();
  const docker = dockerClient(stack.endpointId);

  const [source, candidate, receipt] = await Promise.all([
    inspectContainer(docker, config.sourceContainer),
    inspectContainer(docker, config.candidateName),
    inspectContainer(docker, config.receiptName),
  ]);

  const sourceRunning = running(source);
  const sealedComplete = sealedEnvComplete(source);
  const candidateExists = candidate !== null;
  const receiptExists = receipt !== null;

  return {
    ready:
      stack.active &&
      sourceRunning &&
      sealedComplete &&
      !candidateExists &&
      !receiptExists,
    portainer_local: true,
    stack: {
      id: stack.id,
      name: ELUS_DANFE_CANARY_STACK_NAME,
      endpoint_id: stack.endpointId,
      active: stack.active,
    },
    source_container: {
      name: config.sourceContainer,
      exists: source !== null,
      running: sourceRunning,
      sealed_runtime_env_complete: sealedComplete,
    },
    candidate: {
      name: config.candidateName,
      exists: candidateExists,
      running: running(candidate),
    },
    receipt: {
      name: config.receiptName,
      exists: receiptExists,
    },
  };
}

export async function executeElusDanfeCanaryAgent(
  raw: Record<string, unknown>,
): Promise<ElusDanfeCanaryExecution> {
  const config = canonicalConfig(raw.config);
  const payload = normalizeElusDanfeCanaryPayload({
    conversationId: raw.conversationId,
    pedidoCodigo: raw.pedidoCodigo,
  });

  const stack = await resolveElusStack();
  if (!stack.active) throw new Error("elus_stack_inactive");

  return await executeElusDanfeCanaryOnce(
    dockerClient(stack.endpointId),
    config,
    payload,
  );
}
