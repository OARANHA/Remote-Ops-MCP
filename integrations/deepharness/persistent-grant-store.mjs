/**
 * Single-active-instance persistent grant and Lead-instruction commit store.
 *
 * This is a local policy gate, not a DSH transport. The file must live on the
 * Remote-Ops durable state volume, be writable by one MCP process only, and be
 * provisioned through a separately reviewed administrator path. It stores no
 * instruction text, access token, or OAuth credential.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ACTIONS = new Set(["team.read", "chat.read", "lead.instruct"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GRANTS = 1000;
const MAX_DELIVERIES = 10000;

function denied(code = "grant_denied") { throw new Error(code); }
function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function validId(value) { return typeof value === "string" && ID.test(value); }

function identityOf(value) {
  if (!isObject(value)) denied();
  const { actor, clientId, sessionId, workspaceId, leadSessionId } = value;
  if (![actor, clientId, sessionId, workspaceId, leadSessionId].every(validId) ||
      actor !== `oauth:${clientId}:${sessionId.slice(0, 12)}`) denied();
  return Object.freeze({ actor, clientId, sessionId, workspaceId, leadSessionId });
}

function identityKey(identity) {
  return crypto.createHash("sha256").update(JSON.stringify([
    identity.actor, identity.clientId, identity.sessionId,
    identity.workspaceId, identity.leadSessionId,
  ])).digest("hex");
}

function deliveryKey(identity, idempotencyKey) {
  return crypto.createHash("sha256").update(JSON.stringify([
    identity.actor, identity.clientId, identity.sessionId,
    identity.workspaceId, identity.leadSessionId, idempotencyKey,
  ])).digest("hex");
}

function emptyState() { return { version: 1, grants: {}, deliveries: {} }; }

function normalize(raw) {
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.grants) || !isObject(raw.deliveries) ||
      Object.keys(raw.grants).length > MAX_GRANTS || Object.keys(raw.deliveries).length > MAX_DELIVERIES) denied();
  for (const [key, grant] of Object.entries(raw.grants)) {
    if (!HASH.test(key) || !isObject(grant) || !validId(grant.actor) ||
        !validId(grant.clientId) || !validId(grant.sessionId) ||
        !validId(grant.workspaceId) || !validId(grant.leadSessionId) ||
        grant.actor !== `oauth:${grant.clientId}:${grant.sessionId.slice(0, 12)}` ||
        !Array.isArray(grant.actions) || grant.actions.length < 1 ||
        grant.actions.some(action => !ACTIONS.has(action)) ||
        new Set(grant.actions).size !== grant.actions.length || !validId(grant.revision) ||
        !Number.isSafeInteger(grant.updatedAt) ||
        (grant.revokedAt !== null && !Number.isSafeInteger(grant.revokedAt))) denied();
  }
  for (const [key, delivery] of Object.entries(raw.deliveries)) {
    if (!HASH.test(key) || !isObject(delivery) || !HASH.test(delivery.payloadHash) ||
        !validId(delivery.grantRevision) || !validId(delivery.receiptId) ||
        !validId(delivery.actor) || !validId(delivery.clientId) || !validId(delivery.sessionId) ||
        !validId(delivery.workspaceId) || !validId(delivery.leadSessionId) ||
        !["pending", "accepted"].includes(delivery.status) ||
        !Number.isSafeInteger(delivery.createdAt) ||
        (delivery.acceptedAt !== null && !Number.isSafeInteger(delivery.acceptedAt))) denied();
  }
  return raw;
}

function persistFile(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* retain existing protected mount mode */ }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* mounted filesystems may reject chmod */ }
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* no temporary file remains */ }
    throw error;
  }
}

function loadFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) denied();
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const initial = emptyState();
      persistFile(file, initial);
      return initial;
    }
    denied();
  }
}

/**
 * @param {{file: string, audit?: (event: object) => void, now?: () => number}} options
 * @returns a fail-closed exact grant store and revocation-serialized write gate.
 */
export function createPersistentDshGrantStore({ file, audit = () => {}, now = Date.now } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof audit !== "function" || typeof now !== "function") denied();
  let state = loadFile(file);
  let queue = Promise.resolve();
  let faulted = false;

  const emit = event => { try { audit(Object.freeze({ ts: new Date(now()).toISOString(), ...event })); } catch { /* audit failure never grants authority */ } };
  const save = next => {
    try { persistFile(file, next); state = next; }
    catch (error) { faulted = true; throw error; }
  };
  const serialize = operation => {
    const guarded = async () => { if (faulted) denied("grant_store_unavailable"); return operation(); };
    const result = queue.then(guarded, guarded);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    async putGrant(input) {
      return serialize(async () => {
        const identity = identityOf(input);
        const actions = input.actions;
        if (!Array.isArray(actions) || actions.length < 1 ||
            actions.some(action => !ACTIONS.has(action)) || new Set(actions).size !== actions.length) denied();
        const key = identityKey(identity);
        const previous = state.grants[key];
        if (!previous && Object.keys(state.grants).length >= MAX_GRANTS) denied("grant_store_full");
        const grant = { ...identity, actions: [...actions].sort(), revision: crypto.randomUUID(),
          updatedAt: now(), revokedAt: null };
        const next = { ...state, grants: { ...state.grants, [key]: grant } };
        save(next);
        emit({ action: "grant_put", actor: identity.actor, client_id: identity.clientId,
          workspace_id: identity.workspaceId, lead_session_id: identity.leadSessionId,
          capabilities: grant.actions });
        return Object.freeze({ revision: grant.revision, actions: [...grant.actions] });
      });
    },

    async revokeGrant(input) {
      return serialize(async () => {
        const identity = identityOf(input);
        const key = identityKey(identity);
        const current = state.grants[key];
        if (!current || current.revokedAt !== null) return false;
        const grant = { ...current, revision: crypto.randomUUID(), updatedAt: now(), revokedAt: now() };
        save({ ...state, grants: { ...state.grants, [key]: grant } });
        emit({ action: "grant_revoked", actor: identity.actor, client_id: identity.clientId,
          workspace_id: identity.workspaceId, lead_session_id: identity.leadSessionId });
        return true;
      });
    },

    async lookupCurrentGrant(input) {
      if (faulted) denied("grant_store_unavailable");
      const identity = identityOf(input);
      const grant = state.grants[identityKey(identity)];
      if (!grant || grant.revokedAt !== null ||
          grant.actor !== identity.actor || grant.clientId !== identity.clientId ||
          grant.sessionId !== identity.sessionId || grant.workspaceId !== identity.workspaceId ||
          grant.leadSessionId !== identity.leadSessionId) return null;
      return Object.freeze({ ...identity, actions: [...grant.actions], revision: grant.revision });
    },

    async listCurrentLeadGrants(input) {
      if (!isObject(input)) denied();
      const { actor, clientId, sessionId, workspaceId, action } = input;
      if (![actor, clientId, sessionId, workspaceId].every(validId) ||
          actor !== `oauth:${clientId}:${sessionId.slice(0, 12)}` || action !== "team.read") denied();
      return Object.freeze(Object.values(state.grants)
        .filter(grant => grant.revokedAt === null && grant.actor === actor &&
          grant.clientId === clientId && grant.sessionId === sessionId &&
          grant.workspaceId === workspaceId && grant.actions.includes(action))
        .map(grant => Object.freeze({workspaceId:grant.workspaceId,
          leadSessionId:grant.leadSessionId,revision:grant.revision})));
    },

    async withAuthorizedLeadCommit(input, submit) {
      return serialize(async () => {
        const identity = identityOf(input);
        if (input.action !== "lead.instruct" || !validId(input.revision) ||
            typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey) ||
            typeof input.payloadHash !== "string" || !HASH.test(input.payloadHash) ||
            typeof submit !== "function") denied();
        const grant = state.grants[identityKey(identity)];
        if (!grant || grant.revokedAt !== null || !grant.actions.includes("lead.instruct") ||
            grant.revision !== input.revision) denied();

        const key = deliveryKey(identity, input.idempotencyKey);
        const previous = state.deliveries[key];
        if (previous && (previous.payloadHash !== input.payloadHash ||
            previous.grantRevision !== grant.revision)) denied("idempotency_conflict");
        if (previous?.status === "accepted") {
          emit({ action: "instruction_duplicate", actor: identity.actor, client_id: identity.clientId,
            workspace_id: identity.workspaceId, lead_session_id: identity.leadSessionId,
            idempotency_key_hash: key, outcome: "accepted" });
          return Object.freeze({ accepted: true, authorizationCheckedAtCommit: true,
            grantRevision: grant.revision, receiptId: previous.receiptId, duplicate: true });
        }

        const delivery = previous ?? {
          ...identity, payloadHash: input.payloadHash, grantRevision: grant.revision,
          status: "pending", receiptId: `receipt_${crypto.randomUUID()}`,
          createdAt: now(), acceptedAt: null,
        };
        if (!previous) {
          if (Object.keys(state.deliveries).length >= MAX_DELIVERIES) denied("delivery_store_full");
          save({ ...state, deliveries: { ...state.deliveries, [key]: delivery } });
        }
        emit({ action: previous ? "instruction_retry" : "instruction_commit_started",
          actor: identity.actor, client_id: identity.clientId,
          workspace_id: identity.workspaceId, lead_session_id: identity.leadSessionId,
          idempotency_key_hash: key });
        const acknowledgement = await submit();
        if (acknowledgement?.accepted !== true) denied("dsh_prompt_not_accepted");

        // Re-read the active grant after awaiting DSH. putGrant/revokeGrant use
        // this same queue, so no revocation can interleave with this commit.
        const current = state.grants[identityKey(identity)];
        if (!current || current.revokedAt !== null || current.revision !== grant.revision ||
            !current.actions.includes("lead.instruct")) denied();
        const accepted = { ...delivery, status: "accepted", acceptedAt: now() };
        save({ ...state, deliveries: { ...state.deliveries, [key]: accepted } });
        emit({ action: "instruction_accepted", actor: identity.actor, client_id: identity.clientId,
          workspace_id: identity.workspaceId, lead_session_id: identity.leadSessionId,
          idempotency_key_hash: key, outcome: "accepted" });
        return Object.freeze({ accepted: true, authorizationCheckedAtCommit: true,
          grantRevision: grant.revision, receiptId: accepted.receiptId, duplicate: false });
      });
    },
  });
}
