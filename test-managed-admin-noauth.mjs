#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.AUTH_MODE="noauth";
process.env.AUTH_SECRET="managed-admin-noauth-secret-".padEnd(64,"x");

const managed=await import("./dist/config/managed-admin-approvals.js");
const targets=await import("./dist/config/target-approvals.js");

assert.throws(
  ()=>managed.prepareManagedAdminAction({
    actor:"test",
    targetId:"any-target",
    program:"docker",
    argv:["ps"],
    cwd:"/opt/wandora",
  }),
  /proibido quando AUTH_MODE não é oauth/
);

assert.throws(
  ()=>targets.prepareAgentTarget({
    actor:"test",
    targetId:"managed-admin-test",
    deviceId:"dev_TESTDEVICE1234",
    environment:"production",
    preset:"managed-admin",
  }),
  /AUTH_MODE=oauth/
);

console.log("MANAGED_ADMIN_NOAUTH=GREEN");
