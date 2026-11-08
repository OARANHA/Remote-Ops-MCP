import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "./dist/lib/env.js";
import { portainerStatus, withPortainerConnection } from "./dist/portainer/client.js";

// Testes locais, sem rede ou credenciais reais.
const dir = await mkdtemp(join(tmpdir(), "portainer-instances-"));
const originalFetch = globalThis.fetch;
try {
  const wandoraFile = join(dir, "wandora");
  const vigiaFile = join(dir, "vigia");
  const wandoraToken = "WANDORA_TEST_TOKEN_123456";
  const vigiaToken = "VIGIA_TEST_TOKEN_654321";
  await writeFile(wandoraFile, wandoraToken, { mode: 0o600 });
  await writeFile(vigiaFile, vigiaToken, { mode: 0o600 });
  env.PORTAINER_API_KEY_FILE = wandoraFile;
  env.PORTAINER_VIGIA_API_KEY_FILE = vigiaFile;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), token: init.headers["X-API-Key"] });
    return { ok: true, text: async () => JSON.stringify({ Version: "mock" }) };
  };
  const [a, b, c] = await Promise.all([
    portainerStatus(),
    withPortainerConnection("vigia-elus", () => portainerStatus()),
    withPortainerConnection("wandora", () => portainerStatus()),
  ]);
  assert.equal(a.configuredUrl, "https://portainer.wandora.com.br");
  assert.equal(b.configuredUrl, "https://ops-vigia.wandora.com.br");
  assert.equal(c.configuredUrl, "https://portainer.wandora.com.br");
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(x => x.url.startsWith("https://portainer.wandora.com.br/api/")).length, 2);
  assert.equal(calls.filter(x => x.url.startsWith("https://ops-vigia.wandora.com.br/api/")).length, 1);
  for (const x of calls) {
    const vigia = x.url.startsWith("https://ops-vigia.");
    assert.equal(x.token, vigia ? vigiaToken : wandoraToken);
  }
  assert.throws(() => withPortainerConnection("other", () => portainerStatus()), /desconhecida/);
  console.log("Portainer multi-instância: origem e credencial segregadas, padrão preservado.");
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
