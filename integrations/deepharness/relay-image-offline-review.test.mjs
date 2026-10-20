import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {checkCachedNodeBase} from "./relay-image-offline-review.mjs";

const ROOT=new URL("./",import.meta.url);
const FILE=n=>readFileSync(new URL(n,ROOT),"utf8");
const digest="a".repeat(64);
const imageId="sha256:"+"b".repeat(64);
const imageRef="node@sha256:"+digest;
const valid={imageRef,os:"linux",architecture:"amd64",
  repoDigests:[imageRef],imageId};
test("offline review can only produce PREPARE_ONLY, never deploy authorization",()=>{
  assert.deepEqual(checkCachedNodeBase(valid),{
    status:"PREPARE_ONLY",cached:true,platform:"linux/amd64",
    immutable_ref:imageRef,image_id:imageId,
    node_version_verified:false,provenance_verified:false,
    relay_image_built:false,container_created:false,activation_authorized:false,
  });
});
test("cached image policy denies all mutable, untrusted or wrong-platform candidates",()=>{
  const fail=[
    {imageRef:"node:22"},{imageRef:"node:latest"},
    {imageRef:"ghcr.io/random/node@sha256:"+digest},
    {imageRef:"node@sha256:"+"a".repeat(63)},
    {imageRef:"node@sha256:"+digest+";rm -rf /"},
    {os:"windows"},{architecture:"arm64"},{imageId:"sha256:BAD"},
    {repoDigests:[]},{repoDigests:["node@sha256:"+"c".repeat(64)]},
    {repoDigests:["attacker/node@sha256:"+digest]},
  ];
  for(const change of fail)
    assert.throws(()=>checkCachedNodeBase({...valid,...change}),/DSH_RELAY_IMAGE_REVIEW_NO_GO/);
});
test("review-only Dockerfile copies exactly the Node-builtin relay runtime",()=>{
  const file=FILE("Dockerfile.agent-mesh-relay.review");
  assert.match(file,/^ARG DSH_RELAY_NODE_BASE_IMAGE=docker\\.io\\/library\\/node@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562$/m);
  assert.match(file,/^FROM \$\{DSH_RELAY_NODE_BASE_IMAGE\}$/m);
  assert.match(file,/^USER 65534:65534$/m);
  for(const entry of ["private-bridge-client.mjs","agent-mesh-unix-relay.mjs",
    "agent-mesh-unix-listener.mjs","agent-mesh-unix-relay-run.mjs"])
    assert.ok(file.includes("integrations/deepharness/"+entry),entry);
  assert.doesNotMatch(file,/^# syntax=/m,"no mutable Dockerfile frontend dependency");
  assert.doesNotMatch(file,/^\s*(RUN|ADD|EXPOSE|HEALTHCHECK)\s/m);
  assert.match(file,/CMD \["node","\/opt\/wandora-dsh-relay\/agent-mesh-unix-relay-run.mjs"\]/);
});
test("isolated Compose remains inert, nonroot and private-only",()=>{
  const file=FILE("agent-mesh-relay.compose.review.yml");
  for(const [title,regexp] of [
    ["review profile",/profiles: \["dsh-relay-review"\]/],
    ["no restart",/^\s*restart: "no"$/m],
    ["immutable candidate",/^\s*image: \$\{DSH_RELAY_IMAGE_DIGEST:\?/m],
    ["no image pull",/^\s*pull_policy: never$/m],
    ["numeric UID+GID",/^\s*user: "\$\{DSH_RELAY_UID:\?.*\$\{DSH_RELAY_PRIMARY_GID:\?/m],
    ["ops group",/^\s*group_add:\s*$/m],
    ["read-only root filesystem",/^\s*read_only: true$/m],
    ["no new privileges",/no-new-privileges:true/],
    ["cap drop all",/- ALL/],
    ["closed by default",/DSH_UNIX_RELAY_ENABLED: "\$\{DSH_RELAY_OPERATOR_ENABLE:-0\}"/],
    ["internal network",/^\s*name: deepharness_mcp-private$/m],
    ["CA distinct mount",/target: \/run\/secrets\/dsh-bridge-ca.pem/],
    ["client cert distinct mount",/target: \/run\/secrets\/dsh-bridge-client-cert.pem/],
    ["client key distinct mount",/target: \/run\/secrets\/dsh-bridge-client-key.pem/],
  ])assert.match(file,regexp,title);
  assert.doesNotMatch(file,/^\s*(ports|privileged|network_mode|pid|userns_mode|devices):/m);
  const mounts=(file.match(/read_only: true/g)||[]).length;
  assert.equal(mounts,4,"read-only container and 3 secret file binds");
  assert.equal((file.match(/create_host_path: false/g)||[]).length,4);
  assert.doesNotMatch(file,/docker\.sock|\/var\/run\/docker|network: host/);
});


test("reviewed candidate script only pulls pinned base and builds disconnected; never runs service",()=>{
  const script=FILE("build-relay-candidate.review.sh");
  assert.match(script,/--approved-pull-and-build/);
  assert.match(script,/--verify-existing/);
  assert.match(script,/DSH_RELAY_BUILD=EXISTING_VERIFIED/);
  assert.match(script,/cfg\\.get\\("ExposedPorts"\\)/,"missing ExposedPorts must be accepted");
  assert.match(script,/python3 -c/,"metadata parsed as JSON instead of a missing-key Go template");
  assert.doesNotMatch(script,/\\.Config\\.ExposedPorts\\}\}/,"no unsafe direct Go template access");
  assert.match(script,/hostname.*28server/);
  assert.match(script,/docker pull --platform linux\/amd64 "\$BASE"/);
  assert.match(script,/node@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562/);
  assert.match(script,/docker build --platform linux\/amd64 --pull=false --network=none --no-cache/);
  assert.match(script,/DSH_RELAY_RUNTIME=NOT_STARTED/);
  assert.match(script,/DSH_RELAY_DEPLOY=NOT_PERFORMED/);
  assert.doesNotMatch(script,/\bdocker\s+(?:run|create|start|exec|compose|stack|push|image prune)\b/);
  assert.doesNotMatch(script,/\b(?:useradd|usermod|chmod|chown|systemctl|openssl|kubectl|helm)\b/);
  assert.doesNotMatch(script,/\b(?:eval|source)\s/);
});
