import crypto from "node:crypto";

export const ELUS_DANFE_CANARY_CAPABILITY = "elus.vendaerp_danfe_canary_readonly";
export const ELUS_DANFE_CANARY_REPOSITORY = "ghcr.io/oaranha/elus-danfe-canary";
export const ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE = "/var/lib/wandora-ops-agent/secrets/portainer_api_key";
export const ELUS_DANFE_CANARY_STACK_NAME = "elus";
export const ELUS_DANFE_CANARY_SOURCE_CONTAINER = "elus-app";
export const ELUS_DANFE_CANARY_CANDIDATE_NAME = "wandora-elus-danfe-canary-once";
export const ELUS_DANFE_CANARY_RECEIPT_NAME = "wandora-elus-danfe-canary-receipt";
export const ELUS_DANFE_CANARY_NETWORK = "bridge";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const ELUS_DANFE_CANARY_SEALED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AI_CRED_AES_KEY",
] as const;

type SealedEnvName = (typeof ELUS_DANFE_CANARY_SEALED_ENV)[number];

export interface ElusDanfeCanaryPayload {
  conversationId: string;
  pedidoCodigo: number;
}

export interface ElusDanfeCanaryConfig {
  sourceContainer: string;
  imageRef: string;
  imageRepository: string;
  imageDigest: string;
  revision: string;
  candidateName: string;
  receiptName: string;
  network: string;
}

const FAILURE_CODES = new Set([
  "crm_read_failed",
  "conversation_not_found",
  "order_read_failed",
  "order_not_found",
  "order_ambiguous",
  "identity_unverified",
  "invoice_missing",
  "nfe_read_failed",
  "nfe_number_mismatch",
  "danfe_unavailable",
  "danfe_invalid",
  "preview_upload_failed",
  "preview_sign_failed",
  "preview_fetch_failed",
  "invalid_scope",
  "missing_sealed_runtime_env",
  "unexpected_failure",
  "canary_execution_outcome_unknown",
  "canary_result_invalid",
]);

const PROVIDER_CALLS = [
  "GET Pedidos/Pesquisar",
  "GET Pessoas/Pesquisar",
  "GET Fiscal/ConsultarNFE",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_canary_result");
  return value as Record<string, unknown>;
}

function requireContainerName(value: string, label: string): string {
  if (!CONTAINER_RE.test(value)) throw new Error("invalid_" + label);
  return value;
}

export function normalizeElusDanfeCanaryPayload(raw: Record<string, unknown>): ElusDanfeCanaryPayload {
  for (const key of Object.keys(raw)) {
    if (key !== "conversationId" && key !== "pedidoCodigo") throw new Error("unsupported_canary_argument");
  }
  const conversationId = String(raw.conversationId ?? "");
  const pedidoCodigo = Number(raw.pedidoCodigo);
  if (!UUID_RE.test(conversationId)) throw new Error("invalid_conversation_id");
  if (!Number.isSafeInteger(pedidoCodigo) || pedidoCodigo < 1) throw new Error("invalid_pedido_codigo");
  return { conversationId, pedidoCodigo };
}

export function parseElusDanfeCanaryConfig(raw: {
  sourceContainer?: string;
  image?: string;
  revision?: string;
  candidateName?: string;
  receiptName?: string;
  network?: string;
}): ElusDanfeCanaryConfig | null {
  const sourceContainer = String(raw.sourceContainer ?? "").trim();
  const imageRef = String(raw.image ?? "").trim();
  const revision = String(raw.revision ?? "").trim().toLowerCase();
  const anyCore = sourceContainer.length > 0 || imageRef.length > 0 || revision.length > 0;
  if (!anyCore) return null;
  if (!sourceContainer || !imageRef || !revision) throw new Error("incomplete_elus_danfe_canary_configuration");

  requireContainerName(sourceContainer, "elus_source_container");

  const at = imageRef.lastIndexOf("@");
  if (at <= 0) throw new Error("invalid_elus_canary_image");
  const imageRepository = imageRef.slice(0, at);
  const imageDigest = imageRef.slice(at + 1).toLowerCase();
  if (imageRepository !== ELUS_DANFE_CANARY_REPOSITORY || !SHA256_RE.test(imageDigest)) {
    throw new Error("invalid_elus_canary_image");
  }
  if (!REVISION_RE.test(revision)) throw new Error("invalid_elus_canary_revision");

  const candidateName = requireContainerName(
    String(raw.candidateName ?? "wandora-elus-danfe-canary-once").trim(),
    "elus_canary_candidate_name",
  );
  const receiptName = requireContainerName(
    String(raw.receiptName ?? "wandora-elus-danfe-canary-receipt").trim(),
    "elus_canary_receipt_name",
  );
  if (candidateName === receiptName) throw new Error("elus_canary_names_must_differ");

  const network = String(raw.network ?? "bridge").trim();
  if (!NETWORK_RE.test(network)) throw new Error("invalid_elus_canary_network");

  return {
    sourceContainer,
    imageRef,
    imageRepository,
    imageDigest,
    revision,
    candidateName,
    receiptName,
    network,
  };
}

export function elusDanfeCanaryScopeSha256(payload: ElusDanfeCanaryPayload): string {
  return crypto
    .createHash("sha256")
    .update(payload.conversationId + ":" + String(payload.pedidoCodigo), "utf8")
    .digest("hex");
}

export function extractElusDanfeCanarySealedEnv(env: unknown): Record<SealedEnvName, string> {
  if (!Array.isArray(env)) throw new Error("invalid_source_container_env");
  const found = new Map<SealedEnvName, string>();
  const required = new Set<string>(ELUS_DANFE_CANARY_SEALED_ENV);
  for (const item of env) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = item.slice(0, eq);
    if (!required.has(key)) continue;
    const typed = key as SealedEnvName;
    if (found.has(typed)) throw new Error("duplicate_sealed_runtime_env");
    const value = item.slice(eq + 1);
    if (!value.trim()) throw new Error("missing_sealed_runtime_env");
    found.set(typed, value);
  }
  for (const key of ELUS_DANFE_CANARY_SEALED_ENV) {
    if (!found.has(key)) throw new Error("missing_sealed_runtime_env");
  }
  return Object.fromEntries(found) as Record<SealedEnvName, string>;
}

export function buildElusDanfeCanaryEnv(
  sealed: Record<SealedEnvName, string>,
  payload: ElusDanfeCanaryPayload,
): string[] {
  return [
    ...ELUS_DANFE_CANARY_SEALED_ENV.map((name) => name + "=" + sealed[name]),
    "ELUS_CANARY_CONVERSATION_ID=" + payload.conversationId,
    "ELUS_CANARY_PEDIDO_CODIGO=" + String(payload.pedidoCodigo),
  ];
}

export function sanitizeElusDanfeCanaryResult(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  if (input.ok === false) {
    const code = String(input.code ?? "");
    if (!FAILURE_CODES.has(code)) throw new Error("invalid_canary_failure_code");
    return { ok: false, code, whatsapp_sent: false, vendaerp_writes: 0 };
  }
  if (input.ok !== true) throw new Error("invalid_canary_result");

  const pedidoCodigo = Number(input.pedido_codigo);
  const nfeNumero = Number(input.nfe_numero);
  if (!Number.isSafeInteger(pedidoCodigo) || pedidoCodigo < 1) throw new Error("invalid_canary_pedido");
  if (!Number.isSafeInteger(nfeNumero) || nfeNumero < 1) throw new Error("invalid_canary_nfe");

  const evidenceRaw = input.identity_evidence;
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length < 1 || evidenceRaw.length > 3) {
    throw new Error("invalid_canary_identity_evidence");
  }
  const allowedEvidence = new Set(["cpf", "email", "telefone"]);
  const identityEvidence = evidenceRaw.map((x) => String(x));
  if (identityEvidence.some((x) => !allowedEvidence.has(x)) || new Set(identityEvidence).size !== identityEvidence.length) {
    throw new Error("invalid_canary_identity_evidence");
  }

  if (!Array.isArray(input.provider_calls) || input.provider_calls.length !== PROVIDER_CALLS.length) {
    throw new Error("invalid_canary_provider_calls");
  }
  for (let i = 0; i < PROVIDER_CALLS.length; i++) {
    if (input.provider_calls[i] !== PROVIDER_CALLS[i]) throw new Error("invalid_canary_provider_calls");
  }

  const danfe = asRecord(input.danfe);
  const sizeBytes = Number(danfe.size_bytes);
  if (
    danfe.mime !== "application/pdf" ||
    danfe.pdf_signature !== true ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 5 ||
    sizeBytes > 50 * 1024 * 1024
  ) {
    throw new Error("invalid_canary_danfe");
  }

  const preview = asRecord(input.preview);
  const httpStatus = Number(preview.http_status);
  const expiresSeconds = Number(preview.expires_seconds);
  if (
    preview.ready !== true ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus > 299 ||
    !Number.isInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > 3600
  ) {
    throw new Error("invalid_canary_preview");
  }
  if (input.whatsapp_sent !== false || input.vendaerp_writes !== 0) {
    throw new Error("invalid_canary_effects");
  }

  return {
    ok: true,
    pedido_codigo: pedidoCodigo,
    nfe_numero: nfeNumero,
    identity_evidence: identityEvidence,
    provider_calls: [...PROVIDER_CALLS],
    pedido_localizado: true,
    pessoa_confirmada: true,
    contato_confirmado: true,
    nfe_confirmada: true,
    danfe_valido: true,
    danfe_size_bytes: sizeBytes,
    preview_pronto: true,
    preview_http_status: httpStatus,
    preview_expires_seconds: expiresSeconds,
    whatsapp_sent: false,
    vendaerp_writes: 0,
  };
}

export function encodeElusDanfeCanaryReceipt(result: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(result), "utf8").toString("base64url");
  if (encoded.length > 4096) throw new Error("canary_receipt_too_large");
  return encoded;
}

function validateSanitizedElusDanfeCanaryResult(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  if (input.ok === false) {
    const code = String(input.code ?? "");
    if (!FAILURE_CODES.has(code) || input.whatsapp_sent !== false || input.vendaerp_writes !== 0) {
      throw new Error("invalid_canary_receipt");
    }
    return { ok: false, code, whatsapp_sent: false, vendaerp_writes: 0 };
  }
  if (input.ok !== true) throw new Error("invalid_canary_receipt");

  const pedidoCodigo = Number(input.pedido_codigo);
  const nfeNumero = Number(input.nfe_numero);
  const danfeSizeBytes = Number(input.danfe_size_bytes);
  const previewHttpStatus = Number(input.preview_http_status);
  const previewExpiresSeconds = Number(input.preview_expires_seconds);
  const evidenceRaw = input.identity_evidence;

  if (
    !Number.isSafeInteger(pedidoCodigo) ||
    pedidoCodigo < 1 ||
    !Number.isSafeInteger(nfeNumero) ||
    nfeNumero < 1 ||
    !Number.isSafeInteger(danfeSizeBytes) ||
    danfeSizeBytes < 5 ||
    danfeSizeBytes > 50 * 1024 * 1024 ||
    !Number.isInteger(previewHttpStatus) ||
    previewHttpStatus < 200 ||
    previewHttpStatus > 299 ||
    !Number.isInteger(previewExpiresSeconds) ||
    previewExpiresSeconds < 1 ||
    previewExpiresSeconds > 3600 ||
    !Array.isArray(evidenceRaw) ||
    evidenceRaw.length < 1 ||
    evidenceRaw.length > 3
  ) {
    throw new Error("invalid_canary_receipt");
  }

  const allowedEvidence = new Set(["cpf", "email", "telefone"]);
  const identityEvidence = evidenceRaw.map((x) => String(x));
  if (
    identityEvidence.some((x) => !allowedEvidence.has(x)) ||
    new Set(identityEvidence).size !== identityEvidence.length ||
    !Array.isArray(input.provider_calls) ||
    input.provider_calls.length !== PROVIDER_CALLS.length
  ) {
    throw new Error("invalid_canary_receipt");
  }
  for (let i = 0; i < PROVIDER_CALLS.length; i++) {
    if (input.provider_calls[i] !== PROVIDER_CALLS[i]) throw new Error("invalid_canary_receipt");
  }

  for (const flag of [
    "pedido_localizado",
    "pessoa_confirmada",
    "contato_confirmado",
    "nfe_confirmada",
    "danfe_valido",
    "preview_pronto",
  ]) {
    if (input[flag] !== true) throw new Error("invalid_canary_receipt");
  }
  if (input.whatsapp_sent !== false || input.vendaerp_writes !== 0) {
    throw new Error("invalid_canary_receipt");
  }

  return {
    ok: true,
    pedido_codigo: pedidoCodigo,
    nfe_numero: nfeNumero,
    identity_evidence: identityEvidence,
    provider_calls: [...PROVIDER_CALLS],
    pedido_localizado: true,
    pessoa_confirmada: true,
    contato_confirmado: true,
    nfe_confirmada: true,
    danfe_valido: true,
    danfe_size_bytes: danfeSizeBytes,
    preview_pronto: true,
    preview_http_status: previewHttpStatus,
    preview_expires_seconds: previewExpiresSeconds,
    whatsapp_sent: false,
    vendaerp_writes: 0,
  };
}

export function decodeElusDanfeCanaryReceipt(encoded: unknown): Record<string, unknown> {
  const text = String(encoded ?? "");
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(text)) throw new Error("invalid_canary_receipt");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_canary_receipt");
  }
  return validateSanitizedElusDanfeCanaryResult(parsed);
}
