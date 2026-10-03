import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ELUS_DANFE_CANARY_CAPABILITY,
  ELUS_DANFE_CANARY_PORTAINER_API_KEY_FILE,
  ELUS_DANFE_CANARY_PORTAINER_ENDPOINT_ID,
  ELUS_DANFE_CANARY_PORTAINER_ORIGIN,
  ELUS_DANFE_CANARY_REPOSITORY,
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
assert.equal(ELUS_DANFE_CANARY_PORTAINER_ORIGIN, "https://ops-vigia.wandora.com.br");
assert.equal(ELUS_DANFE_CANARY_PORTAINER_ENDPOINT_ID, 3);
assert.equal(ELUS_DANFE_CANARY_PORTAINER_API_KEY_FILE, "/app/secrets/portainer_vigia_api_key");

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
assert.equal(toolsSource.includes("baseUrl:ELUS_DANFE_CANARY_PORTAINER_ORIGIN"), true);
assert.equal(toolsSource.includes("apiKeyFile:ELUS_DANFE_CANARY_PORTAINER_API_KEY_FILE"), true);
assert.equal(toolsSource.includes('agentJson(t,"elus.vendaerp_danfe_canary_readonly"'), false);

const compose = fs.readFileSync("docker-compose.portainer.yml", "utf8");
for (const name of [
  "ELUS_DANFE_CANARY_SOURCE_CONTAINER",
  "ELUS_DANFE_CANARY_IMAGE",
  "ELUS_DANFE_CANARY_REVISION",
  "ELUS_DANFE_CANARY_CONTAINER_NAME",
  "ELUS_DANFE_CANARY_RECEIPT_NAME",
  "ELUS_DANFE_CANARY_NETWORK",
]) {
  assert.equal(compose.includes(name), true, name + " must be wired into docker-read-proxy");
}

console.log("ELUS_DANFE_CANARY_CONTRACT=GREEN");
