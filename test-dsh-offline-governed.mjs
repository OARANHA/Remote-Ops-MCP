import assert from "node:assert/strict";
import {
  LAB_NAME, LAB_TARGET_ID, LAB_CAPABILITY, REQUIRED_CHECKS,
  validateLabImage, offlineLabCreateRequest, parseLabAttestation,
} from "./dist/docker/vigiafast-offline-probe.js";

const digest = "sha256:" + "a".repeat(64);
assert.equal(LAB_NAME,"vigiafast-dsh-offline-probe");
assert.equal(LAB_TARGET_ID,"vigiafast-dsh-lab");
assert.equal(LAB_CAPABILITY,"vigiafast.dsh.offline_probe");
for(const bad of ["", "latest", "vigiafast/dsh:latest", "sha256:123", "sha256:"+"A".repeat(64), "sha256:"+"a".repeat(64)+";touch /tmp/foo", null]){
  assert.throws(()=>validateLabImage(bad),undefined,String(bad));
}
const config=offlineLabCreateRequest(digest);
assert.equal(config.Image,digest);
assert.equal(config.User,"10001:10001");
assert.equal(config.NetworkDisabled,true);
assert.equal(config.Tty,false);
assert.equal(config.AttachStdin,false);
assert.deepEqual(Object.keys(config).sort(),[
  "AttachStderr","AttachStdin","AttachStdout","Env","HostConfig","Image",
  "NetworkDisabled","Tty","User",
].sort(), "no unreviewed docker create fields");
const host=config.HostConfig;
assert.equal(host.NetworkMode,"none");
assert.equal(host.Privileged,false);
assert.equal(host.ReadonlyRootfs,true);
assert.deepEqual(host.CapDrop,["ALL"]);
assert.deepEqual(host.SecurityOpt,["no-new-privileges:true"]);
assert.deepEqual(host.Mounts,[]);
assert.deepEqual(host.Binds,[]);
assert.deepEqual(host.PortBindings,{});
assert.equal(host.PidsLimit,32);
assert.equal(host.Memory,256*1024*1024);
assert.equal(host.NanoCpus,500_000_000);
assert.equal(host.RestartPolicy.Name,"no");
assert.ok(host.Tmpfs["/tmp"].includes("noexec"));
assert.ok(config.Env.every(s=>!/(?:API_KEY|PASSWORD|TOKEN|SECRET)=/i.test(s)));
const checks=Object.fromEntries(REQUIRED_CHECKS.map(x=>[x,true]));
const safe=parseLabAttestation({type:"offline_lab_attestation",ok:true,checks,rogue:"NEVER_RETURN"},0);
assert.equal(safe.ok,true);
assert.equal(safe.checks.no_provider_material,true);
assert.equal(Object.hasOwn(safe.checks,"no_provider_secret"),false);
assert.equal(Object.hasOwn(safe,"rogue"),false);
assert.equal(parseLabAttestation({type:"offline_lab_attestation",ok:true,checks},1).ok,false);
const badChecks={...checks,read_only_root:false};
assert.equal(parseLabAttestation({type:"offline_lab_attestation",ok:false,checks:badChecks},1).ok,false);
for(const invalid of [
  null,{},[],{type:"offline_lab_attestation",ok:true,checks:{}},
  {type:"offline_lab_attestation",ok:true,checks:{...checks,no_provider_secret:"true"}},
  {type:"offline_lab_attestation",ok:true,checks:{...checks,extra:true}},
  {type:"offline_lab_attestation",ok:false,checks},
  {type:"offline_lab_attestation",ok:true,checks:badChecks},
])assert.throws(()=>parseLabAttestation(invalid,0));
console.log("dsh offline governed capability contract: PASS (image pin, no mounts/network, strict attestations)");
