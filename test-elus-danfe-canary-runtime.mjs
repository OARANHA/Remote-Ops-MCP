import assert from "node:assert/strict";

import {
  ELUS_DANFE_CANARY_CAPABILITY,
  ELUS_DANFE_CANARY_REPOSITORY,
  parseElusDanfeCanaryConfig,
} from "./dist/docker/elus-danfe-canary.js";
import { executeElusDanfeCanaryOnce } from "./dist/docker/elus-danfe-canary-runtime.js";

const revision = "5".repeat(40);
const digest = "sha256:" + "7".repeat(64);
const imageRef = ELUS_DANFE_CANARY_REPOSITORY + "@" + digest;
const tagRef = ELUS_DANFE_CANARY_REPOSITORY + ":" + revision;
const config = parseElusDanfeCanaryConfig({
  sourceContainer: "elus-app",
  image: imageRef,
  revision,
});
assert.ok(config);

const payload = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  pedidoCodigo: 123,
};

function dockerStream(text) {
  const data = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

const sourceSecrets = {
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  AI_CRED_AES_KEY: "aes-secret",
};
let imagePresent = false;
let candidatePresent = false;
let candidateRunning = false;
let receiptInspect = null;
let sourceReads = 0;
let candidateCreates = 0;
let candidateStarts = 0;
let pulls = 0;
let lastCandidateCreate = null;

const successfulRawResult = {
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
    size_bytes: 4096,
    pdf_signature: true,
  },
  preview: {
    ready: true,
    storage_path: "private/path.pdf",
    http_status: 200,
    expires_seconds: 600,
  },
  whatsapp_sent: false,
  vendaerp_writes: 0,
};

const docker = {
  async request(method, path, body) {
    if (method === "GET" && path === "/containers/" + config.receiptName + "/json") {
      return receiptInspect
        ? { status: 200, body: Buffer.from(JSON.stringify(receiptInspect)) }
        : { status: 404, body: Buffer.from("{}") };
    }
    if (method === "GET" && path === "/containers/" + config.candidateName + "/json") {
      if (!candidatePresent) return { status: 404, body: Buffer.from("{}") };
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            Config: { Labels: lastCandidateCreate.Labels },
            State: { Running: candidateRunning },
          }),
        ),
      };
    }
    if (method === "GET" && path === "/images/" + encodeURIComponent(tagRef) + "/json") {
      if (!imagePresent) return { status: 404, body: Buffer.from("{}") };
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            RepoDigests: [imageRef],
            Config: { Labels: { "org.opencontainers.image.revision": revision } },
          }),
        ),
      };
    }
    if (method === "POST" && path.startsWith("/images/create?")) {
      pulls++;
      assert.equal(path.includes(encodeURIComponent(ELUS_DANFE_CANARY_REPOSITORY)), true);
      assert.equal(path.includes(encodeURIComponent(revision)), true);
      imagePresent = true;
      return { status: 200, body: Buffer.from('{"status":"pulled"}\n') };
    }
    if (method === "GET" && path === "/containers/elus-app/json") {
      sourceReads++;
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            Config: {
              Env: [
                ...Object.entries(sourceSecrets).map(([k, v]) => k + "=" + v),
                "INTERNAL_SECRET=must-not-cross",
                "WAHA_API_KEY=must-not-cross",
              ],
            },
          }),
        ),
      };
    }
    if (
      method === "POST" &&
      path === "/containers/create?name=" + encodeURIComponent(config.candidateName)
    ) {
      candidateCreates++;
      lastCandidateCreate = JSON.parse(body.toString("utf8"));
      assert.equal(lastCandidateCreate.Image, imageRef);
      assert.deepEqual(lastCandidateCreate.Cmd, [
        "/app/node_modules/.bin/tsx",
        "/app/scripts/elus-vendaerp-danfe-canary.ts",
      ]);
      assert.equal(lastCandidateCreate.HostConfig.Privileged, false);
      assert.equal(lastCandidateCreate.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(lastCandidateCreate.HostConfig.CapDrop, ["ALL"]);
      assert.equal(lastCandidateCreate.HostConfig.NetworkMode, "bridge");
      assert.equal(lastCandidateCreate.Env.some((x) => x.includes("must-not-cross")), false);
      for (const [key, value] of Object.entries(sourceSecrets)) {
        assert.equal(lastCandidateCreate.Env.includes(key + "=" + value), true);
      }
      assert.equal(
        lastCandidateCreate.Env.includes("ELUS_CANARY_CONVERSATION_ID=" + payload.conversationId),
        true,
      );
      assert.equal(lastCandidateCreate.Env.includes("ELUS_CANARY_PEDIDO_CODIGO=123"), true);
      const serialized = JSON.stringify(lastCandidateCreate);
      assert.equal(serialized.includes("/var/run/docker.sock"), false);
      assert.equal(serialized.includes("Binds"), false);
      candidatePresent = true;
      return { status: 201, body: Buffer.from(JSON.stringify({ Id: "a".repeat(64) })) };
    }
    if (method === "POST" && path === "/containers/" + "a".repeat(64) + "/start") {
      candidateStarts++;
      candidateRunning = true;
      return { status: 204, body: Buffer.alloc(0) };
    }
    if (
      method === "POST" &&
      path === "/containers/" + "a".repeat(64) + "/wait?condition=not-running"
    ) {
      candidateRunning = false;
      return { status: 200, body: Buffer.from('{"StatusCode":0}') };
    }
    if (
      method === "GET" &&
      path === "/containers/" + config.candidateName + "/logs?stdout=1&stderr=1&tail=50"
    ) {
      return {
        status: 200,
        body: dockerStream(JSON.stringify(successfulRawResult) + "\n"),
      };
    }
    if (
      method === "POST" &&
      path === "/containers/create?name=" + encodeURIComponent(config.receiptName)
    ) {
      const receiptCreate = JSON.parse(body.toString("utf8"));
      assert.equal(receiptCreate.Image, imageRef);
      assert.deepEqual(receiptCreate.Env, []);
      assert.equal(JSON.stringify(receiptCreate).includes("service-role-secret"), false);
      assert.equal(JSON.stringify(receiptCreate).includes("aes-secret"), false);
      assert.equal(JSON.stringify(receiptCreate).includes(payload.conversationId), false);
      receiptInspect = {
        Config: { Labels: receiptCreate.Labels },
        State: { Running: false },
      };
      return { status: 201, body: Buffer.from(JSON.stringify({ Id: "b".repeat(64) })) };
    }
    if (
      method === "DELETE" &&
      path === "/containers/" + config.candidateName + "?force=1&v=1"
    ) {
      candidatePresent = false;
      candidateRunning = false;
      return { status: 204, body: Buffer.alloc(0) };
    }
    throw new Error("unexpected fake Docker call: " + method + " " + path);
  },
};

const first = await executeElusDanfeCanaryOnce(docker, config, payload);
assert.equal(first.replayed, false);
assert.equal(first.result.ok, true);
assert.equal(first.result.preview_pronto, true);
assert.equal(first.result.whatsapp_sent, false);
assert.equal(first.result.vendaerp_writes, 0);
const firstText = JSON.stringify(first);
assert.equal(firstText.includes(payload.conversationId), false);
assert.equal(firstText.includes("private/path.pdf"), false);
assert.equal(firstText.includes("service-role-secret"), false);
assert.equal(pulls, 1);
assert.equal(sourceReads, 1);
assert.equal(candidateCreates, 1);
assert.equal(candidateStarts, 1);
assert.ok(receiptInspect);

const second = await executeElusDanfeCanaryOnce(docker, config, payload);
assert.equal(second.replayed, true);
assert.deepEqual(second.result, first.result);
assert.equal(pulls, 1, "replay must not pull again");
assert.equal(sourceReads, 1, "replay must not read sealed runtime again");
assert.equal(candidateCreates, 1, "replay must not create another candidate");
assert.equal(candidateStarts, 1, "replay must not execute another candidate");

await assert.rejects(
  () =>
    executeElusDanfeCanaryOnce(docker, config, {
      ...payload,
      pedidoCodigo: 124,
    }),
  /canary_already_consumed/,
);
assert.equal(candidateStarts, 1, "different scope must not consume a second real call");

const receiptLabels = receiptInspect.Config.Labels;
assert.equal(receiptLabels["wandora.semantic.capability"], ELUS_DANFE_CANARY_CAPABILITY);
assert.equal(receiptLabels["wandora.semantic.revision"], revision);
assert.equal(receiptLabels["wandora.semantic.scope_sha256"].length, 64);
assert.equal(receiptLabels["wandora.semantic.scope_sha256"].includes(payload.conversationId), false);

console.log("ELUS_DANFE_CANARY_RUNTIME=GREEN");
