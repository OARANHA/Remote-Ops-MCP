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

console.log("DOCKER_PROXY_COMPOSE_CANDIDATE_ENV_WIRING=GREEN");
