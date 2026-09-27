import assert from "node:assert/strict";
import {
  POSTGRES_PINNED_READBACK_CAPABILITY,
  buildPostgresPinnedReadbackExec,
  normalizePostgresPinnedReadbackPayload,
  parsePostgresVerifierAllowlist,
  postgresVerifierSha256,
  postgresSqlAfterApprovedMetaCommands,
} from "./dist/docker/postgres-readback.js";

const sql = "\\set ON_ERROR_STOP on\n\\pset pager off\nDO $ BEGIN IF 1 <> 1 THEN RAISE EXCEPTION 'bad'; END IF; END $;\nSELECT 'VERIFY OK' AS result;";
const sha = postgresVerifierSha256(sql);
const verifiers = parsePostgresVerifierAllowlist(`commercial-crm-core=${sha}`);

assert.equal(POSTGRES_PINNED_READBACK_CAPABILITY, "postgres.pinned_readback");
assert.equal(verifiers.get("commercial-crm-core"), sha);
assert.throws(() => parsePostgresVerifierAllowlist("bad"), /invalid_postgres_verifier_allowlist/);
assert.throws(() => parsePostgresVerifierAllowlist(`commercial-crm-core=${sha},commercial-crm-core=${sha}`), /duplicate_postgres_verifier_id/);

const payload = normalizePostgresPinnedReadbackPayload({ verifierId: "commercial-crm-core", sql, ignored: true });
assert.deepEqual(payload, { verifierId: "commercial-crm-core", sql });
assert.throws(() => normalizePostgresPinnedReadbackPayload({ verifierId: "../bad", sql }), /invalid_postgres_verifier_id/);
assert.throws(() => normalizePostgresPinnedReadbackPayload({ verifierId: "commercial-crm-core", sql: "" }), /invalid_postgres_verifier_sql/);

const spec = buildPostgresPinnedReadbackExec({
  container: "supabase-db",
  execUser: "postgres",
  dbUser: "postgres",
  dbName: "postgres",
  verifiers,
}, payload);

assert.equal(spec.container, "supabase-db");
assert.equal(spec.execUser, "postgres");
assert.equal(spec.sha256, sha);
assert.equal(spec.cmd[0], "psql");
assert.equal(spec.cmd.includes("sh"), false);
assert.equal(spec.cmd.includes("bash"), false);
assert.equal(spec.cmd.join(" ").includes("BEGIN TRANSACTION READ ONLY"), true);
assert.equal(spec.cmd.join(" ").includes("ROLLBACK"), true);
assert.equal(spec.cmd.join(" ").includes("\\set ON_ERROR_STOP on"), false);
assert.equal(spec.cmd.join(" ").includes("\\pset pager off"), false);
assert.equal(postgresSqlAfterApprovedMetaCommands(sql).includes("VERIFY OK"), true);
assert.equal(spec.env.some((x) => x.includes("default_transaction_read_only=on")), true);
assert.equal(spec.env.some((x) => /password/i.test(x)), false);

assert.throws(() => buildPostgresPinnedReadbackExec({
  container: "supabase-db",
  execUser: "postgres",
  dbUser: "postgres",
  dbName: "postgres",
  verifiers,
}, { verifierId: "commercial-crm-core", sql: sql + "\nSELECT 2;" }), /postgres_verifier_hash_mismatch/);

assert.throws(() => buildPostgresPinnedReadbackExec({
  container: "supabase-db",
  execUser: "postgres",
  dbUser: "postgres",
  dbName: "postgres",
  verifiers,
}, { verifierId: "not-approved", sql }), /postgres_verifier_not_allowed/);

for (const unsafeMeta of ["\\\\! id", "\\\\copy public.contacts to '/tmp/x'", "\\\\include /tmp/x.sql"]) {
  const unsafeSql = unsafeMeta + "\nSELECT 1;";
  const unsafeHash = postgresVerifierSha256(unsafeSql);
  assert.throws(() => buildPostgresPinnedReadbackExec({
    container: "supabase-db",
    execUser: "postgres",
    dbUser: "postgres",
    dbName: "postgres",
    verifiers: new Map([["unsafe-verifier", unsafeHash]]),
  }, { verifierId: "unsafe-verifier", sql: unsafeSql }), /unsupported_postgres_meta_command/);
}

console.log("POSTGRES_PINNED_READBACK_TEST=GREEN");
