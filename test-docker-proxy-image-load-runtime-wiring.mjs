import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync("docker-compose.portainer.yml", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

const marker = "  docker-read-proxy:";
const start = compose.indexOf(marker);
assert.notEqual(start, -1, "docker-read-proxy service missing");
const rest = compose.slice(start + marker.length);
const end = rest.indexOf("\nnetworks:");
const proxy = end === -1 ? rest : rest.slice(0, end);

const requiredEnv = [
  "ALLOWED_DOCKER_IMAGE_LOAD_ROOTS",
  "ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES",
  "ALLOWED_DOCKER_CANDIDATE_NETWORKS",
  "ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES",
  "ALLOWED_DOCKER_CANDIDATE_HOST_PORTS",
  "ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS",
];

for (const key of requiredEnv) {
  assert.ok(
    proxy.includes(key + ": ${" + key + ":-}"),
    "docker-read-proxy must receive " + key,
  );
  assert.match(
    envExample,
    new RegExp("^" + key + "=.*$", "m"),
    ".env.example must document " + key,
  );
}

assert.ok(
  proxy.includes("${DOCKER_IMAGE_LOAD_ROOT_HOST:-/opt/wandora/ops-workspace}:${DOCKER_IMAGE_LOAD_ROOT_CONTAINER:-/opt/wandora/ops-workspace}:ro"),
  "docker-read-proxy must mount the governed image-load root read-only",
);
assert.match(envExample, /^DOCKER_IMAGE_LOAD_ROOT_HOST=.*$/m);
assert.match(envExample, /^DOCKER_IMAGE_LOAD_ROOT_CONTAINER=.*$/m);

console.log("DOCKER_PROXY_IMAGE_LOAD_RUNTIME_WIRING=GREEN");
