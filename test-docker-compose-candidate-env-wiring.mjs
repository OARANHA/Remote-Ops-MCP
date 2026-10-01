import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync("docker-compose.portainer.yml", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

const composeMappings = [
  "ALLOWED_DOCKER_IMAGE_LOAD_ROOTS: ${ALLOWED_DOCKER_IMAGE_LOAD_ROOTS:-}",
  "ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES: ${ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES:-}",
  "ALLOWED_DOCKER_CANDIDATE_NETWORKS: ${ALLOWED_DOCKER_CANDIDATE_NETWORKS:-}",
  "ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES: ${ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES:-}",
  "ALLOWED_DOCKER_CANDIDATE_HOST_PORTS: ${ALLOWED_DOCKER_CANDIDATE_HOST_PORTS:-}",
  "ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS: ${ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS:-}",
];

for (const mapping of composeMappings) {
  assert.ok(compose.includes(mapping), "missing compose wiring: " + mapping);
}

const envKeys = [
  "ALLOWED_DOCKER_IMAGE_LOAD_ROOTS=",
  "ALLOWED_DOCKER_CANDIDATE_IMAGE_PREFIXES=",
  "ALLOWED_DOCKER_CANDIDATE_NETWORKS=",
  "ALLOWED_DOCKER_CANDIDATE_NAME_PREFIXES=",
  "ALLOWED_DOCKER_CANDIDATE_HOST_PORTS=",
  "ALLOWED_DOCKER_CANDIDATE_CONTAINER_PORTS=",
];

for (const key of envKeys) {
  assert.ok(envExample.includes(key), "missing env example key: " + key);
}

const imageLoadOverlay = "docker-compose.image-load-root.yml";
assert.ok(fs.existsSync(imageLoadOverlay), "missing opt-in image-load root overlay");
const overlay = fs.readFileSync(imageLoadOverlay, "utf8");
assert.ok(
  overlay.includes("source: ${DOCKER_IMAGE_LOAD_ROOT_HOST:?defina DOCKER_IMAGE_LOAD_ROOT_HOST}"),
  "image-load overlay must require an explicit host source",
);
assert.ok(
  overlay.includes("target: ${DOCKER_IMAGE_LOAD_ROOT_CONTAINER:-/opt/wandora/ops-workspace}"),
  "image-load overlay must preserve a stable in-proxy path",
);
assert.ok(overlay.includes("read_only: true"), "image-load root mount must be read-only");
assert.ok(envExample.includes("DOCKER_IMAGE_LOAD_ROOT_HOST="), "missing host mount env example");
assert.ok(envExample.includes("DOCKER_IMAGE_LOAD_ROOT_CONTAINER=/opt/wandora/ops-workspace"), "missing container mount env example");
console.log("DOCKER_PROXY_COMPOSE_CANDIDATE_ENV_WIRING=GREEN");
