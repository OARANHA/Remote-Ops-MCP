import crypto from "node:crypto";

export const POSTGRES_PINNED_READBACK_CAPABILITY = "postgres.pinned_readback";

export interface PostgresPinnedReadbackPayload {
  verifierId: string;
  sql: string;
}

export interface PostgresPinnedReadbackConfig {
  container: string;
  execUser: string;
  dbUser: string;
  dbName: string;
  verifiers: Map<string, string>;
}

export interface PostgresPinnedReadbackExec {
  verifierId: string;
  sha256: string;
  container: string;
  execUser: string;
  env: string[];
  cmd: string[];
}

const VERIFIER_ID_RE = /^[a-z0-9][a-z0-9_.-]{1,79}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;

export function parsePostgresVerifierAllowlist(raw = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const at = entry.indexOf("=");
    if (at <= 0 || at === entry.length - 1) throw new Error("invalid_postgres_verifier_allowlist");
    const verifierId = entry.slice(0, at).trim();
    const sha256 = entry.slice(at + 1).trim().toLowerCase();
    if (!VERIFIER_ID_RE.test(verifierId) || !SHA256_RE.test(sha256)) throw new Error("invalid_postgres_verifier_allowlist");
    if (out.has(verifierId)) throw new Error("duplicate_postgres_verifier_id");
    out.set(verifierId, sha256);
  }
  return out;
}

export function normalizePostgresPinnedReadbackPayload(raw: Record<string, unknown>): PostgresPinnedReadbackPayload {
  const verifierId = String(raw.verifierId ?? "");
  const sql = String(raw.sql ?? "");
  if (!VERIFIER_ID_RE.test(verifierId)) throw new Error("invalid_postgres_verifier_id");
  if (sql.length === 0 || Buffer.byteLength(sql, "utf8") > 128 * 1024 || sql.includes("\0")) throw new Error("invalid_postgres_verifier_sql");
  return { verifierId, sql };
}

export function postgresVerifierSha256(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex");
}

export function postgresSqlAfterApprovedMetaCommands(sql: string): string {
  const out: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("\\")) {
      out.push(line);
      continue;
    }
    if (trimmed === "\\set ON_ERROR_STOP on" || trimmed === "\\pset pager off") continue;
    throw new Error("unsupported_postgres_meta_command");
  }
  return out.join("\n");
}

function requireSafeName(value: string, label: string): string {
  if (!SAFE_NAME_RE.test(value)) throw new Error("invalid_" + label);
  return value;
}

export function buildPostgresPinnedReadbackExec(
  config: PostgresPinnedReadbackConfig,
  payload: PostgresPinnedReadbackPayload,
): PostgresPinnedReadbackExec {
  const expected = config.verifiers.get(payload.verifierId);
  if (!expected) throw new Error("postgres_verifier_not_allowed");
  const sha256 = postgresVerifierSha256(payload.sql);
  if (sha256 !== expected) throw new Error("postgres_verifier_hash_mismatch");

  const container = requireSafeName(config.container, "postgres_container");
  const execUser = requireSafeName(config.execUser, "postgres_exec_user");
  const dbUser = requireSafeName(config.dbUser, "postgres_db_user");
  const dbName = requireSafeName(config.dbName, "postgres_db_name");
  const executableSql = postgresSqlAfterApprovedMetaCommands(payload.sql);

  const wrappedSql = "BEGIN TRANSACTION READ ONLY;\n" + executableSql + "\nROLLBACK;\n";
  return {
    verifierId: payload.verifierId,
    sha256,
    container,
    execUser,
    env: [
      "PGAPPNAME=wandora-postgres-pinned-readback",
      "PGCONNECT_TIMEOUT=5",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=3000",
    ],
    cmd: ["psql", "-w", "-X", "-v", "ON_ERROR_STOP=1", "-U", dbUser, "-d", dbName, "-c", wrappedSql],
  };
}
