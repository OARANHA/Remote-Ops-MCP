/**
 * DeepHarness semantic read/write policy boundary for Remote-Ops-MCP.
 *
 * Dependency-injected contract, NOT an active MCP tool or DSH transport.
 * No Docker exec, shell, session impersonation or unrestricted enumeration.
 * The future DSH backend must enforce grants atomically at write commit.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REV = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["team.read", "chat.read", "lead.instruct"]);

function deny() {
  throw new Error("deepharness_capability_denied");
}

function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) deny();
  return value;
}

function scopeOf(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) deny();
  return {
    workspaceId: identifier(input.workspaceId),
    leadSessionId: identifier(input.leadSessionId),
  };
}

function principalOf(trusted) {
  if (!trusted || typeof trusted !== "object" || Array.isArray(trusted)) deny();
  // This identity must come from verified OAuth middleware, never tool arguments.
  const { actor, clientId, sessionId } = trusted;
  if (typeof actor !== "string" || !actor.startsWith("oauth:") ||
      typeof clientId !== "string" || !ID.test(clientId) ||
      typeof sessionId !== "string" || !ID.test(sessionId) ||
      actor !== "oauth:" + clientId + ":" + sessionId.slice(0, 12)) deny();
  return Object.freeze({ actor, clientId, sessionId });
}

function validateGrant(grant, principal, scope, action) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) deny();
  if (grant.actor !== principal.actor || grant.clientId !== principal.clientId ||
      grant.sessionId !== principal.sessionId ||
      grant.workspaceId !== scope.workspaceId ||
      grant.leadSessionId !== scope.leadSessionId ||
      !Array.isArray(grant.actions) || !grant.actions.includes(action) ||
      grant.actions.some(x => !ACTIONS.has(x)) ||
      typeof grant.revision !== "string" || !REV.test(grant.revision)) deny();
  return Object.freeze({ actor: principal.actor, clientId: principal.clientId,
    sessionId: principal.sessionId, workspaceId: scope.workspaceId,
    leadSessionId: scope.leadSessionId, action, revision: grant.revision });
}

export function createDeepharnessSemanticPolicy(dependencies = {}) {
  const { lookupCurrentGrant, readAuthorizedTeam, readAuthorizedChat,
          commitAuthorizedInstruction } = dependencies;
  if (typeof lookupCurrentGrant !== "function" ||
      typeof readAuthorizedTeam !== "function" ||
      typeof readAuthorizedChat !== "function" ||
      typeof commitAuthorizedInstruction !== "function") deny();

  async function authority(trustedContext, input, action) {
    const principal = principalOf(trustedContext);
    const scope = scopeOf(input);
    const grant = await lookupCurrentGrant(Object.freeze({ ...principal, ...scope }));
    return validateGrant(grant, principal, scope, action);
  }

  async function recheck(expected) {
    const fresh = await lookupCurrentGrant(Object.freeze({
      actor: expected.actor, clientId: expected.clientId,
      sessionId: expected.sessionId, workspaceId: expected.workspaceId,
      leadSessionId: expected.leadSessionId,
    }));
    validateGrant(fresh, expected, expected, expected.action);
    if (fresh.revision !== expected.revision) deny();
  }

  return Object.freeze({
    async readTeam(trustedContext, input) {
      const auth = await authority(trustedContext, input, "team.read");
      // DSH backend must return a lossy bounded Team projection, no raw secrets.
      const result = await readAuthorizedTeam(auth);
      await recheck(auth);
      return result;
    },
    async readChat(trustedContext, input) {
      const auth = await authority(trustedContext, input, "chat.read");
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) deny();
      const result = await readAuthorizedChat(Object.freeze({ ...auth, limit: input.limit }));
      await recheck(auth);
      return result;
    },
    async sendLeadInstruction(trustedContext, input) {
      const auth = await authority(trustedContext, input, "lead.instruct");
      if (typeof input.instruction !== "string" ||
          input.instruction.trim().length < 1 ||
          Buffer.byteLength(input.instruction, "utf8") > 4096 ||
          /[\0]/.test(input.instruction) ||
          typeof input.idempotencyKey !== "string" ||
          !UUID.test(input.idempotencyKey)) deny();
      // Trusted write provider MUST revalidate the exact grant/revision at
      // prompt admission and enforce (caller scope, idempotencyKey) uniqueness.
      // A preflight-only permission check cannot authorize async writes.
      const ack = await commitAuthorizedInstruction(Object.freeze({
        ...auth, instruction: input.instruction, idempotencyKey: input.idempotencyKey,
      }));
      if (!ack || ack.authorizationCheckedAtCommit !== true ||
          ack.grantRevision !== auth.revision ||
          ack.accepted !== true ||
          typeof ack.receiptId !== "string" || !ID.test(ack.receiptId) ||
          typeof ack.duplicate !== "boolean") deny();
      return Object.freeze({
        workspace_id: auth.workspaceId, lead_session_id: auth.leadSessionId,
        // This is the Remote-Ops durable commit receipt, not a DSH event ID.
        receipt_id: ack.receiptId, accepted: true, duplicate: ack.duplicate,
      });
    },
  });
}
