import assert from "node:assert/strict";
import crypto from "node:crypto";

const mod=await import("./dist/privileged/managed-admin-ticket.js");
const secret="x".repeat(64);
const now=Date.now();
const ticket={
  v:1,
  target_id:"managed-admin-test",
  device_id:"dev_TESTDEVICE1234",
  program:"printf",
  argv:["hello"],
  cwd:"/tmp",
  timeout_ms:5000,
  nonce:crypto.randomBytes(24).toString("hex"),
  issued_at:now,
  expires_at:now+60_000,
};
const pub1=mod.deriveManagedAdminPublicKeyPem(secret);
const pub2=mod.deriveManagedAdminPublicKeyPem(secret);
assert.equal(pub1,pub2);
assert.match(pub1,/BEGIN PUBLIC KEY/);
const sig=mod.signManagedAdminTicket(ticket,secret);
assert.equal(mod.verifyManagedAdminTicket(ticket,sig,pub1),true);
assert.equal(mod.verifyManagedAdminTicket({...ticket,argv:["tampered"]},sig,pub1),false);
assert.equal(mod.verifyManagedAdminTicket(ticket,sig.slice(0,-2)+"aa",pub1),false);
assert.throws(()=>mod.normalizeManagedAdminTicket({...ticket,program:"bash -lc"}));
assert.throws(()=>mod.normalizeManagedAdminTicket({...ticket,expires_at:now+180_000}));
console.log("MANAGED_ADMIN_TICKET=GREEN");
