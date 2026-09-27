import crypto, { type KeyObject } from "node:crypto";

export interface ManagedAdminTicketV1 {
  v: 1;
  target_id: string;
  device_id: string;
  program: string;
  argv: string[];
  cwd: string;
  timeout_ms: number;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DEVICE_RE = /^dev_[A-Za-z0-9_-]{8,80}$/;
const PROGRAM_RE = /^[A-Za-z0-9_.+-]{1,80}$/;
const NONCE_RE = /^[a-f0-9]{32,128}$/;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const DOMAIN = Buffer.from("remote-ops-managed-admin-ticket-v1\0", "utf8");

function seedFromSecret(secret: string): Buffer {
  if (secret.length < 32) throw new Error("managed_admin_signing_secret_too_short");
  return crypto.createHash("sha256").update(DOMAIN).update(secret, "utf8").digest();
}

export function deriveManagedAdminPrivateKey(secret: string): KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seedFromSecret(secret)]),
    format: "der",
    type: "pkcs8",
  });
}

export function deriveManagedAdminPublicKeyPem(secret: string): string {
  return crypto.createPublicKey(deriveManagedAdminPrivateKey(secret))
    .export({ format: "pem", type: "spki" })
    .toString();
}

export function normalizeManagedAdminTicket(raw: unknown): ManagedAdminTicketV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("managed_admin_ticket_invalid");
  const x = raw as Record<string, unknown>;
  const v = Number(x.v);
  const target_id = String(x.target_id ?? "");
  const device_id = String(x.device_id ?? "");
  const program = String(x.program ?? "");
  const argv = Array.isArray(x.argv) ? x.argv.map((a) => String(a ?? "")) : [];
  const cwd = String(x.cwd ?? "");
  const timeout_ms = Number(x.timeout_ms);
  const nonce = String(x.nonce ?? "");
  const issued_at = Number(x.issued_at);
  const expires_at = Number(x.expires_at);
  if (v !== 1) throw new Error("managed_admin_ticket_version_invalid");
  if (!ID_RE.test(target_id)) throw new Error("managed_admin_target_invalid");
  if (!DEVICE_RE.test(device_id)) throw new Error("managed_admin_device_invalid");
  if (!PROGRAM_RE.test(program)) throw new Error("managed_admin_program_invalid");
  if (!Array.isArray(x.argv) || argv.length > 80) throw new Error("managed_admin_argv_invalid");
  for (const arg of argv) {
    if (Buffer.byteLength(arg, "utf8") > 16_384 || /[\0\r\n]/.test(arg)) throw new Error("managed_admin_argument_invalid");
  }
  if (!cwd.startsWith("/") || cwd.length > 1024 || /[\0\r\n]/.test(cwd) || cwd.split("/").includes("..")) throw new Error("managed_admin_cwd_invalid");
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1_000 || timeout_ms > 120_000) throw new Error("managed_admin_timeout_invalid");
  if (!NONCE_RE.test(nonce)) throw new Error("managed_admin_nonce_invalid");
  if (!Number.isInteger(issued_at) || !Number.isInteger(expires_at) || expires_at <= issued_at || expires_at - issued_at > 120_000) {
    throw new Error("managed_admin_expiry_invalid");
  }
  return { v:1,target_id,device_id,program,argv,cwd,timeout_ms,nonce,issued_at,expires_at };
}

export function managedAdminTicketBytes(ticket: ManagedAdminTicketV1): Buffer {
  const t = normalizeManagedAdminTicket(ticket);
  return Buffer.from(JSON.stringify({
    v:t.v,
    target_id:t.target_id,
    device_id:t.device_id,
    program:t.program,
    argv:t.argv,
    cwd:t.cwd,
    timeout_ms:t.timeout_ms,
    nonce:t.nonce,
    issued_at:t.issued_at,
    expires_at:t.expires_at,
  }), "utf8");
}

export function signManagedAdminTicket(ticket: ManagedAdminTicketV1, secret: string): string {
  return crypto.sign(null, managedAdminTicketBytes(ticket), deriveManagedAdminPrivateKey(secret)).toString("base64url");
}

export function verifyManagedAdminTicket(ticket: ManagedAdminTicketV1, signature: string, publicKeyPem: string): boolean {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(signature)) return false;
  try {
    return crypto.verify(
      null,
      managedAdminTicketBytes(ticket),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
