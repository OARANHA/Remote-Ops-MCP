import {
  ELUS_DANFE_CANARY_CAPABILITY,
  buildElusDanfeCanaryEnv,
  decodeElusDanfeCanaryReceipt,
  elusDanfeCanaryScopeSha256,
  encodeElusDanfeCanaryReceipt,
  extractElusDanfeCanarySealedEnv,
  sanitizeElusDanfeCanaryResult,
  type ElusDanfeCanaryConfig,
  type ElusDanfeCanaryPayload,
} from "./elus-danfe-canary.js";

export interface DockerSemanticResponse {
  status: number;
  body: Buffer;
}

export interface ElusDanfeCanaryDockerClient {
  request(
    method: string,
    path: string,
    body?: Buffer,
    options?: { timeoutMs?: number; maxBytes?: number },
  ): Promise<DockerSemanticResponse>;
}

export interface ElusDanfeCanaryExecution {
  result: Record<string, unknown>;
  replayed: boolean;
}

const LABEL_CAPABILITY = "wandora.semantic.capability";
const LABEL_SCOPE = "wandora.semantic.scope_sha256";
const LABEL_REVISION = "wandora.semantic.revision";
const LABEL_RESULT = "wandora.semantic.result_b64";

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseJson(body: Buffer, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function labelsOf(inspect: Record<string, unknown>): Record<string, string> {
  const config = inspect.Config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const labels = (config as Record<string, unknown>).Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function dockerEnvOf(inspect: Record<string, unknown>): unknown {
  const config = inspect.Config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_source_container_inspect");
  return (config as Record<string, unknown>).Env;
}

function runningOf(inspect: Record<string, unknown>): boolean {
  const state = inspect.State;
  return !!state && typeof state === "object" && !Array.isArray(state) && (state as Record<string, unknown>).Running === true;
}

function demuxDockerStream(body: Buffer): { stdout: string; stderr: string } {
  let i = 0;
  let stdout = "";
  let stderr = "";
  let frames = 0;
  while (i + 8 <= body.length) {
    const stream = body[i];
    const len = body.readUInt32BE(i + 4);
    if (i + 8 + len > body.length) break;
    const text = body.subarray(i + 8, i + 8 + len).toString("utf8");
    if (stream === 2) stderr += text;
    else stdout += text;
    i += 8 + len;
    frames++;
  }
  if (frames === 0) stdout = body.toString("utf8");
  return { stdout, stderr };
}

function resultFromLogs(body: Buffer): Record<string, unknown> {
  const { stdout } = demuxDockerStream(body);
  const lines = stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return sanitizeElusDanfeCanaryResult(JSON.parse(lines[i]!));
    } catch {
      // Try an earlier line. Only the final sanitized JSON contract is accepted.
    }
  }
  throw new Error("invalid_canary_output");
}

async function inspectContainer(
  docker: ElusDanfeCanaryDockerClient,
  name: string,
): Promise<Record<string, unknown> | null> {
  const response = await docker.request("GET", "/containers/" + encodeURIComponent(name) + "/json");
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error("canary_container_inspect_failed");
  return parseJson(response.body, "invalid_canary_container_inspect");
}

async function removeContainerBestEffort(
  docker: ElusDanfeCanaryDockerClient,
  name: string,
): Promise<void> {
  await docker
    .request("DELETE", "/containers/" + encodeURIComponent(name) + "?force=1&v=1", undefined, {
      timeoutMs: 15_000,
    })
    .catch(() => null);
}

async function readCandidateResult(
  docker: ElusDanfeCanaryDockerClient,
  name: string,
): Promise<Record<string, unknown>> {
  const logs = await docker.request(
    "GET",
    "/containers/" + encodeURIComponent(name) + "/logs?stdout=1&stderr=1&tail=50",
    undefined,
    { timeoutMs: 15_000, maxBytes: 256 * 1024 },
  );
  if (logs.status !== 200) throw new Error("canary_logs_failed");
  return resultFromLogs(logs.body);
}

async function createReceipt(
  docker: ElusDanfeCanaryDockerClient,
  config: ElusDanfeCanaryConfig,
  scopeSha256: string,
  result: Record<string, unknown>,
): Promise<void> {
  const resultB64 = encodeElusDanfeCanaryReceipt(result);
  const body = jsonBody({
    Image: config.imageRef,
    Cmd: ["/bin/true"],
    Env: [],
    Labels: {
      [LABEL_CAPABILITY]: ELUS_DANFE_CANARY_CAPABILITY,
      [LABEL_SCOPE]: scopeSha256,
      [LABEL_REVISION]: config.revision,
      [LABEL_RESULT]: resultB64,
    },
    HostConfig: {
      NetworkMode: "none",
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 16,
    },
  });
  const created = await docker.request(
    "POST",
    "/containers/create?name=" + encodeURIComponent(config.receiptName),
    body,
  );
  if (created.status === 201) return;
  if (created.status !== 409) throw new Error("canary_receipt_create_failed");

  const existing = await inspectContainer(docker, config.receiptName);
  if (!existing) throw new Error("canary_receipt_create_failed");
  const labels = labelsOf(existing);
  if (
    labels[LABEL_CAPABILITY] !== ELUS_DANFE_CANARY_CAPABILITY ||
    labels[LABEL_SCOPE] !== scopeSha256 ||
    labels[LABEL_REVISION] !== config.revision
  ) {
    throw new Error("canary_already_consumed");
  }
  const existingResult = decodeElusDanfeCanaryReceipt(labels[LABEL_RESULT]);
  if (JSON.stringify(existingResult) !== JSON.stringify(result)) throw new Error("canary_receipt_result_mismatch");
}

async function finalizeExistingCandidate(
  docker: ElusDanfeCanaryDockerClient,
  config: ElusDanfeCanaryConfig,
  payload: ElusDanfeCanaryPayload,
  inspect: Record<string, unknown>,
): Promise<ElusDanfeCanaryExecution> {
  const scopeSha256 = elusDanfeCanaryScopeSha256(payload);
  const labels = labelsOf(inspect);
  if (
    labels[LABEL_CAPABILITY] !== ELUS_DANFE_CANARY_CAPABILITY ||
    labels[LABEL_SCOPE] !== scopeSha256 ||
    labels[LABEL_REVISION] !== config.revision
  ) {
    throw new Error("canary_already_consumed");
  }
  if (runningOf(inspect)) throw new Error("canary_in_progress");

  let result: Record<string, unknown>;
  try {
    result = await readCandidateResult(docker, config.candidateName);
  } catch {
    result = sanitizeElusDanfeCanaryResult({ ok: false, code: "canary_result_invalid" });
  }
  await createReceipt(docker, config, scopeSha256, result);
  await removeContainerBestEffort(docker, config.candidateName);
  return { result, replayed: true };
}

async function checkReceipt(
  docker: ElusDanfeCanaryDockerClient,
  config: ElusDanfeCanaryConfig,
  payload: ElusDanfeCanaryPayload,
): Promise<ElusDanfeCanaryExecution | null> {
  const inspect = await inspectContainer(docker, config.receiptName);
  if (!inspect) return null;
  const labels = labelsOf(inspect);
  const scopeSha256 = elusDanfeCanaryScopeSha256(payload);
  if (
    labels[LABEL_CAPABILITY] !== ELUS_DANFE_CANARY_CAPABILITY ||
    labels[LABEL_REVISION] !== config.revision
  ) {
    throw new Error("invalid_canary_receipt");
  }
  if (labels[LABEL_SCOPE] !== scopeSha256) throw new Error("canary_already_consumed");
  const result = decodeElusDanfeCanaryReceipt(labels[LABEL_RESULT]);
  await removeContainerBestEffort(docker, config.candidateName);
  return { result, replayed: true };
}

async function ensurePinnedImage(
  docker: ElusDanfeCanaryDockerClient,
  config: ElusDanfeCanaryConfig,
): Promise<void> {
  const tagRef = config.imageRepository + ":" + config.revision;
  let inspected = await docker.request("GET", "/images/" + encodeURIComponent(tagRef) + "/json");
  if (inspected.status === 404) {
    const pull = await docker.request(
      "POST",
      "/images/create?fromImage=" +
        encodeURIComponent(config.imageRepository) +
        "&tag=" +
        encodeURIComponent(config.revision),
      undefined,
      { timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024 },
    );
    if (pull.status !== 200) throw new Error("canary_image_pull_failed");
    const pullText = pull.body.toString("utf8");
    if (/"error(?:Detail)?"\s*:/.test(pullText)) throw new Error("canary_image_pull_failed");
    inspected = await docker.request("GET", "/images/" + encodeURIComponent(tagRef) + "/json");
  }
  if (inspected.status !== 200) throw new Error("canary_image_inspect_failed");

  const image = parseJson(inspected.body, "invalid_canary_image_inspect");
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests.map(String) : [];
  if (!digests.includes(config.imageRef)) throw new Error("canary_image_digest_mismatch");
  const imageConfig = image.Config;
  const imageLabels =
    imageConfig && typeof imageConfig === "object" && !Array.isArray(imageConfig)
      ? (imageConfig as Record<string, unknown>).Labels
      : null;
  const labels =
    imageLabels && typeof imageLabels === "object" && !Array.isArray(imageLabels)
      ? (imageLabels as Record<string, unknown>)
      : {};
  if (labels["org.opencontainers.image.revision"] !== config.revision) {
    throw new Error("canary_image_revision_mismatch");
  }
}

export async function executeElusDanfeCanaryOnce(
  docker: ElusDanfeCanaryDockerClient,
  config: ElusDanfeCanaryConfig,
  payload: ElusDanfeCanaryPayload,
): Promise<ElusDanfeCanaryExecution> {
  const previous = await checkReceipt(docker, config, payload);
  if (previous) return previous;

  const candidateInspect = await inspectContainer(docker, config.candidateName);
  if (candidateInspect) return await finalizeExistingCandidate(docker, config, payload, candidateInspect);

  await ensurePinnedImage(docker, config);

  const source = await docker.request(
    "GET",
    "/containers/" + encodeURIComponent(config.sourceContainer) + "/json",
  );
  if (source.status !== 200) throw new Error("elus_source_container_unavailable");
  const sourceInspect = parseJson(source.body, "invalid_source_container_inspect");
  const sealed = extractElusDanfeCanarySealedEnv(dockerEnvOf(sourceInspect));
  const scopeSha256 = elusDanfeCanaryScopeSha256(payload);

  const createBody = jsonBody({
    Image: config.imageRef,
    Cmd: ["node", "--import", "tsx", "/app/scripts/elus-vendaerp-danfe-canary.ts"],
    Env: [
      ...buildElusDanfeCanaryEnv(sealed, payload),
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "TSX_DISABLE_CACHE=1",
      "NEXT_TELEMETRY_DISABLED=1",
    ],
    Labels: {
      [LABEL_CAPABILITY]: ELUS_DANFE_CANARY_CAPABILITY,
      [LABEL_SCOPE]: scopeSha256,
      [LABEL_REVISION]: config.revision,
    },
    HostConfig: {
      NetworkMode: config.network,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      Memory: 536870912,
      Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=33554432" },
    },
  });
  const created = await docker.request(
    "POST",
    "/containers/create?name=" + encodeURIComponent(config.candidateName),
    createBody,
  );
  if (created.status === 409) {
    const concurrent = await inspectContainer(docker, config.candidateName);
    if (!concurrent) throw new Error("canary_candidate_create_conflict");
    return await finalizeExistingCandidate(docker, config, payload, concurrent);
  }
  if (created.status !== 201) throw new Error("canary_candidate_create_failed");
  const createdJson = parseJson(created.body, "invalid_canary_candidate_create");
  const candidateId = String(createdJson.Id ?? "");
  if (!/^[a-f0-9]{12,64}$/i.test(candidateId)) throw new Error("invalid_canary_candidate_id");

  const started = await docker.request("POST", "/containers/" + candidateId + "/start", Buffer.alloc(0));
  if (started.status !== 204) {
    await removeContainerBestEffort(docker, config.candidateName);
    throw new Error("canary_candidate_start_failed");
  }

  const waited = await docker.request(
    "POST",
    "/containers/" + candidateId + "/wait?condition=not-running",
    Buffer.alloc(0),
    { timeoutMs: 120_000, maxBytes: 64 * 1024 },
  );
  if (waited.status !== 200) {
    const result = sanitizeElusDanfeCanaryResult({
      ok: false,
      code: "canary_execution_outcome_unknown",
    });
    await createReceipt(docker, config, scopeSha256, result);
    await removeContainerBestEffort(docker, config.candidateName);
    return { result, replayed: false };
  }

  let result: Record<string, unknown>;
  try {
    result = await readCandidateResult(docker, config.candidateName);
  } catch {
    result = sanitizeElusDanfeCanaryResult({ ok: false, code: "canary_result_invalid" });
  }
  await createReceipt(docker, config, scopeSha256, result);
  await removeContainerBestEffort(docker, config.candidateName);
  return { result, replayed: false };
}
