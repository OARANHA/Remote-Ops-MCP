import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ELUS_DANFE_CANARY_CAPABILITY,
  ELUS_DANFE_CANARY_CANDIDATE_NAME,
  ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE,
  ELUS_DANFE_CANARY_NETWORK,
  ELUS_DANFE_CANARY_RECEIPT_NAME,
  ELUS_DANFE_CANARY_REPOSITORY,
  ELUS_DANFE_CANARY_SOURCE_CONTAINER,
  ELUS_DANFE_CANARY_STACK_NAME,
  buildElusDanfeCanaryEnv,
  decodeElusDanfeCanaryReceipt,
  elusDanfeCanaryScopeSha256,
  encodeElusDanfeCanaryReceipt,
  extractElusDanfeCanarySealedEnv,
  normalizeElusDanfeCanaryPayload,
  parseElusDanfeCanaryConfig,
  sanitizeElusDanfeCanaryResult,
} from "./dist/docker/elus-danfe-canary.js";

const revision = "5".repeat(40);
const digest = "sha256:" + "7".repeat(64);
const image = ELUS_DANFE_CANARY_REPOSITORY + "@" + digest;

assert.equal(ELUS_DANFE_CANARY_CAPABILITY, "elus.vendaerp_danfe_canary_readonly");
assert.equal(ELUS_DANFE_CANARY_LOCAL_PORTAINER_API_KEY_FILE, "/var/lib/wandora-ops-agent/secrets/portainer_api_key");
assert.equal(ELUS_DANFE_CANARY_STACK_NAME, "elus");
assert.equal(ELUS_DANFE_CANARY_SOURCE_CONTAINER, "elus-app");
assert.equal(ELUS_DANFE_CANARY_CANDIDATE_NAME, "wandora-elus-danfe-canary-once");
assert.equal(ELUS_DANFE_CANARY_RECEIPT_NAME, "wandora-elus-danfe-canary-receipt");
assert.equal(ELUS_DANFE_CANARY_NETWORK, "bridge");

const payload = normalizeElusDanfeCanaryPayload({
  conversationId: "11111111-1111-4111-8111-111111111111",
  pedidoCodigo: 123,
});
assert.deepEqual(payload, {
  conversationId: "11111111-1111-4111-8111-111111111111",
  pedidoCodigo: 123,
});
assert.throws(
  () => normalizeElusDanfeCanaryPayload({ ...payload, extra: "no" }),
  /unsupported_canary_argument/,
);
assert.throws(
  () => normalizeElusDanfeCanaryPayload({ conversationId: "../bad", pedidoCodigo: 123 }),
  /invalid_conversation_id/,
);
assert.throws(
  () => normalizeElusDanfeCanaryPayload({ conversationId: payload.conversationId, pedidoCodigo: 0 }),
  /invalid_pedido_codigo/,
);

assert.equal(parseElusDanfeCanaryConfig({}), null);
const config = parseElusDanfeCanaryConfig({
  sourceContainer: "elus-app",
  image,
  revision,
});
assert.ok(config);
assert.equal(config.imageRef, image);
assert.equal(config.imageDigest, digest);
assert.equal(config.network, "bridge");
assert.throws(
  () =>
    parseElusDanfeCanaryConfig({
      sourceContainer: "elus-app",
      image: "ghcr.io/other/image@" + digest,
      revision,
    }),
  /invalid_elus_canary_image/,
);
assert.throws(
  () => parseElusDanfeCanaryConfig({ sourceContainer: "elus-app", image, revision: "" }),
  /incomplete_elus_danfe_canary_configuration/,
);

const sourceEnv = [
  "NEXT_PUBLIC_SUPABASE_URL=https://supabase.invalid",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-public",
  "SUPABASE_SERVICE_ROLE_KEY=service-secret",
  "AI_CRED_AES_KEY=aes-secret",
  "INTERNAL_SECRET=must-not-cross",
  "WAHA_API_KEY=must-not-cross",
];
const sealed = extractElusDanfeCanarySealedEnv(sourceEnv);
assert.deepEqual(Object.keys(sealed).sort(), [
  "AI_CRED_AES_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
]);
const candidateEnv = buildElusDanfeCanaryEnv(sealed, payload);
assert.equal(candidateEnv.some((x) => x.includes("must-not-cross")), false);
assert.equal(candidateEnv.some((x) => x === "ELUS_CANARY_PEDIDO_CODIGO=123"), true);
assert.equal(
  candidateEnv.some((x) => x === "ELUS_CANARY_CONVERSATION_ID=" + payload.conversationId),
  true,
);
assert.throws(
  () => extractElusDanfeCanarySealedEnv(sourceEnv.filter((x) => !x.startsWith("AI_CRED_AES_KEY="))),
  /missing_sealed_runtime_env/,
);

const rawSuccess = {
  ok: true,
  conversation_id: payload.conversationId,
  pedido_codigo: 123,
  nfe_numero: 456,
  identity_evidence: ["cpf", "email"],
  provider_calls: [
    "GET Pedidos/Pesquisar",
    "GET Pessoas/Pesquisar",
    "GET Fiscal/ConsultarNFE",
  ],
  danfe: {
    mime: "application/pdf",
    size_bytes: 2048,
    pdf_signature: true,
    raw_url: "https://must-not-leak.invalid",
  },
  preview: {
    ready: true,
    storage_path: "org/conversation/private.pdf",
    signed_url: "https://must-not-leak.invalid/signed",
    http_status: 200,
    expires_seconds: 600,
  },
  whatsapp_sent: false,
  vendaerp_writes: 0,
};
const safe = sanitizeElusDanfeCanaryResult(rawSuccess);
assert.equal(safe.ok, true);
assert.equal(safe.pedido_localizado, true);
assert.equal(safe.pessoa_confirmada, true);
assert.equal(safe.contato_confirmado, true);
assert.equal(safe.nfe_confirmada, true);
assert.equal(safe.danfe_valido, true);
assert.equal(safe.preview_pronto, true);
const safeText = JSON.stringify(safe);
assert.equal(safeText.includes(payload.conversationId), false);
assert.equal(safeText.includes("storage_path"), false);
assert.equal(safeText.includes("signed_url"), false);
assert.equal(safeText.includes("must-not-leak"), false);

const failure = sanitizeElusDanfeCanaryResult({
  ok: false,
  code: "identity_unverified",
  detail: "raw-provider-detail-must-not-leak",
});
assert.deepEqual(failure, {
  ok: false,
  code: "identity_unverified",
  whatsapp_sent: false,
  vendaerp_writes: 0,
});
assert.equal(JSON.stringify(failure).includes("raw-provider"), false);
assert.throws(
  () => sanitizeElusDanfeCanaryResult({ ok: false, code: "arbitrary-provider-error" }),
  /invalid_canary_failure_code/,
);

const receipt = encodeElusDanfeCanaryReceipt(safe);
assert.deepEqual(decodeElusDanfeCanaryReceipt(receipt), safe);
assert.equal(elusDanfeCanaryScopeSha256(payload).length, 64);
assert.notEqual(
  elusDanfeCanaryScopeSha256(payload),
  elusDanfeCanaryScopeSha256({ ...payload, pedidoCodigo: 124 }),
);

const toolsSource = fs.readFileSync("src/tools/index.ts", "utf8");
assert.equal(toolsSource.includes('agentJson(t,"elus.vendaerp_danfe_canary_preflight"'), true);
assert.equal(toolsSource.includes('agentJson(t,"elus.vendaerp_danfe_canary_readonly"'), true);
assert.equal(toolsSource.includes("portainer_vigia_api_key"), false);
assert.equal(toolsSource.includes("ops-vigia.wandora.com.br"), false);

const agentSource = fs.readFileSync("src/agent/elus-danfe-local.ts", "utf8");
assert.equal(agentSource.includes('const LOCAL_PORTAINER_HOST = "127.0.0.1"'), true);
assert.equal(agentSource.includes("rejectUnauthorized: false"), true);
assert.equal(agentSource.includes('"/api/stacks"'), true);
assert.equal(agentSource.includes("ELUS_DANFE_CANARY_STACK_NAME"), true);
assert.equal(agentSource.includes("DOCKER_HOST"), false);
assert.equal(agentSource.includes("23751"), false);
assert.equal(agentSource.includes("X-API-Key"), true);
assert.equal(agentSource.includes("PORTAINER_ENDPOINT_ID"), false);
assert.equal(agentSource.includes("PORTAINER_STACK_ID"), false);

const operationsSource = fs.readFileSync("src/agent/operations.ts", "utf8");
const elusStart = operationsSource.indexOf("async function executeElusDanfeCanaryOperation");
const elusEnd = operationsSource.indexOf("async function executePaperclipSemanticOperation", elusStart);
const elusBlock = operationsSource.slice(elusStart, elusEnd);
assert.equal(elusBlock.includes("docker_read_proxy_required"), false);
assert.equal(elusBlock.includes("127.0.0.1:23751"), false);
assert.equal(elusBlock.includes("Promise.race"), false);

const compose = fs.readFileSync("docker-compose.portainer.yml", "utf8");
assert.equal(compose.includes("ELUS_DANFE_CANARY_PORTAINER_ENDPOINT_ID"), false);
const proxyBlock = compose.split("remote-ops-docker-read-proxy:")[1] ?? "";
for (const name of [
  "ELUS_DANFE_CANARY_SOURCE_CONTAINER",
  "ELUS_DANFE_CANARY_IMAGE",
  "ELUS_DANFE_CANARY_REVISION",
  "ELUS_DANFE_CANARY_CONTAINER_NAME",
  "ELUS_DANFE_CANARY_RECEIPT_NAME",
  "ELUS_DANFE_CANARY_NETWORK",
]) {
  assert.equal(proxyBlock.includes(name), false, name + " must not be wired into docker-read-proxy");
}

console.log("ELUS_DANFE_CANARY_CONTRACT=GREEN");
