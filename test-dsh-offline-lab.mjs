import assert from "node:assert/strict";
import fs from "node:fs";
import { rootMountIsReadOnly } from "./labs/dsh-offline/mountinfo.mjs";

const compose = fs.readFileSync("labs/dsh-offline/compose.yaml", "utf8");
const image = fs.readFileSync("labs/dsh-offline/Dockerfile", "utf8");
const probe = fs.readFileSync("labs/dsh-offline/probe.mjs", "utf8");

for (const [label, rx] of [
  ["manual opt-in", /^\s*profiles:\s*\["manual"\]/m],
  ["disable network namespace", /^\s*network_mode:\s*["']?none["']?\s*$/m],
  ["read-only root", /^\s*read_only:\s*true\s*$/m],
  ["non-root UID", /^\s*user:\s*["']10001:10001["']\s*$/m],
  ["no Linux capabilities", /^\s*cap_drop:\s*\["ALL"\]\s*$/m],
  ["no new privileges", /^\s*-\s*["']no-new-privileges:true["']\s*$/m],
  ["not privileged", /^\s*privileged:\s*false\s*$/m],
  ["limited memory", /^\s*mem_limit:\s*256m\s*$/m],
  ["limited CPU", /^\s*cpus:\s*0\.5\s*$/m],
  ["limited PIDs", /^\s*pids_limit:\s*32\s*$/m],
  ["no restart", /^\s*restart:\s*["']no["']\s*$/m],
  ["tmpfs only", /^\s*tmpfs:\s*$/m],
]) assert.match(compose, rx, label);

for (const forbidden of ["ports", "expose", "volumes", "devices", "secrets", "env_file", "links", "extra_hosts", "network_mode_override", "pid", "ipc", "dns", "dns_search", "entrypoint", "command"]) {
  assert.doesNotMatch(compose, new RegExp("^\\s*" + forbidden + "\\s*:", "m"), "forbidden Compose field: " + forbidden);
}

assert.match(image, /^FROM node:24\.21\.0-bookworm-slim$/m, "explicit Node tag");
assert.match(image, /^USER 10001:10001$/m, "runtime nonroot");
assert.match(image, /^ENTRYPOINT \["node", "\/opt\/vigiafast\/probe\.mjs"\]$/m, "fixed fixture");
assert.doesNotMatch(image, /^RUN\s/m, "no installer, shell setup or download at build");
assert.doesNotMatch(image, /CHUTES_API_KEY|GITHUB_TOKEN|docker\.sock/i, "no secret or privileged socket in image");
assert.match(probe, /no_provider_secret:/, "check absence of provider keys");
assert.match(probe, /rootMountIsReadOnly\(fs\.readFileSync\("\/proc\/self\/mountinfo"/, "root mount flags checked");
assert.match(probe, /no_docker_socket:/, "check absence of Docker socket");
assert.match(probe, /loopback_only:/, "check loopback-only net namespace");
assert.doesNotMatch(probe, /(?:https?:\/\/|fetch\s*\()/i, "probe must not make network requests");
// A non-root user receives EACCES from /etc on a writable rootfs.
// Root mount flags must be checked, never a file-write failure alone.
const mi = options => `17 1 0:29 / / ${options} - overlay overlay ${options}\n18 17 0:30 / /etc rw,relatime - tmpfs tmpfs rw\n`;
assert.equal(rootMountIsReadOnly(mi("ro,relatime")), true, "read-only root mount");
assert.equal(rootMountIsReadOnly(mi("rw,relatime")), false, "writable root must fail");
assert.equal(rootMountIsReadOnly(mi("ro,rw,relatime")), false, "ambiguous root flags must fail");
assert.equal(rootMountIsReadOnly(mi("rw,relatime").replace(" / / rw", " / /missing rw")), false, "missing root mount fails");
assert.equal(rootMountIsReadOnly(mi("ro,relatime") + mi("ro,relatime")), false, "duplicate root mounts fail");
assert.equal(rootMountIsReadOnly(""), false, "empty mountinfo fails");
assert.equal(rootMountIsReadOnly(null), false, "invalid mountinfo fails");
console.log("offline dsh container contract: PASS (manifest and read-only root mount negative tests)");
