#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { filterDockerListByAllowlist } = await import("./src/security/docker-list-scope.ts");

const inventory = [
  { name: "deepharness-web-1", image: "dsh:stable" },
  { name: "deepharness-mcp-grants-db-1", image: "postgres:17" },
  { name: "supabase-db", image: "supabase/postgres:17" },
];

test("Docker list exposes only names in the exact target allowlist", () => {
  assert.deepEqual(filterDockerListByAllowlist(inventory, [
    "deepharness-web-1", "deepharness-mcp-grants-db-1",
  ]), inventory.slice(0, 2));
});

test("empty allowlist returns no container metadata", () => {
  assert.deepEqual(filterDockerListByAllowlist(inventory, []), []);
});

test("explicit wildcard is the only way to expose the complete Docker list", () => {
  assert.deepEqual(filterDockerListByAllowlist(inventory, ["*"]), inventory);
});

test("malformed rows and malformed allowlists fail closed", () => {
  assert.deepEqual(filterDockerListByAllowlist([...inventory, null, { image: "unknown" }], ["*"]), inventory);
  assert.deepEqual(filterDockerListByAllowlist(inventory, null), []);
});

test("docker_list filters mock inventory with the loaded target policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-list-policy-"));
  try {
    process.env.MOCK_MODE = "1";
    process.env.STATE_FILE = path.join(dir, "state.json");
    process.env.AUDIT_FILE = path.join(dir, "audit.jsonl");
    process.env.TARGETS_FILE = path.join(dir, "targets.json");
    process.env.AUTH_MODE = "noauth";
    fs.writeFileSync(process.env.TARGETS_FILE, JSON.stringify({ targets: [
      { id: "dsh-scope", transport: "mock", environment: "production", capabilityProfile: "read-only",
        allowedDockerContainers: ["wandora-web", "supabase-db"] },
      { id: "empty-scope", transport: "mock", environment: "production", capabilityProfile: "read-only",
        allowedDockerContainers: [] },
    ] }));

    const state = await import("./dist/state/store.js");
    const targets = await import("./dist/config/targets.js");
    const tools = await import("./dist/tools/index.js");
    state.initStateStore();
    targets.loadRegistry();
    const dockerList = tools.TOOL_DEFS.find(tool => tool.name === "docker_list");
    const allowed = await dockerList.run({ target: "dsh-scope" }, { actor: "test", requestId: "test" });
    assert.deepEqual(allowed.containers.map(item => item.name), ["wandora-web", "supabase-db"]);
    assert.equal(allowed.count, 2);

    const empty = await dockerList.run({ target: "empty-scope" }, { actor: "test", requestId: "test" });
    assert.deepEqual(empty, { target: "empty-scope", count: 0, containers: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("DOCKER_LIST_SCOPE=GREEN");
