/**
 * DSH 0.2.1-alpha.2 official host service adapter (pinned upstream
 * d743267388641bc76f17c45ce8b4c231aed1d32c).
 *
 * NOT a network service or MCP registration. Must run in the initialized DSH
 * Web service context, with trusted deps and a server-side authorization gate.
 * SessionController.prompt is a human user-prompt; TeamService.sendMessage
 * requires an actual Team-member Agent and is intentionally NOT used.
 */
import { createHash } from "node:crypto";

const DENIED = "deepharness_host_operation_denied";
function deny() { throw new Error(DENIED); }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(x) { if (typeof x !== "string" || !ID.test(x)) deny(); return x; }
function obj(x) { if (!x || typeof x !== "object" || Array.isArray(x)) deny(); return x; }
function scalarText(s, max) { return typeof s === "string" ? s.slice(0, max) : ""; }

function dshRequestId(scope, idempotencyKey) {
  const input = JSON.stringify([
    scope.actor, scope.clientId, scope.sessionId,
    scope.workspaceId, scope.leadSessionId, idempotencyKey,
  ]);
  return "mcp_" + createHash("sha256").update(input).digest("hex");
}

function authority(auth) {
  obj(auth);
  const workspaceId = id(auth.workspaceId);
  const leadSessionId = id(auth.leadSessionId);
  const revision = id(auth.revision);
  const actor = id(auth.actor);
  const clientId = id(auth.clientId);
  const sessionId = id(auth.sessionId);
  if (actor !== `oauth:${clientId}:${sessionId.slice(0, 12)}`) deny();
  return { workspaceId, leadSessionId, revision, actor, clientId, sessionId };
}

export function createOfficialDshHostSessionBackend(deps = {}) {
  const { sessionController, workspaceRegistry, withAuthorizedLeadCommit } = deps;
  if (typeof sessionController?.projections !== "function" ||
      typeof sessionController?.inspect !== "function" ||
      typeof sessionController?.prompt !== "function" ||
      typeof workspaceRegistry?.get !== "function" ||
      typeof withAuthorizedLeadCommit !== "function") deny();

  // An exact registered workspace/Lead match is necessary, never sufficient.
  // The outer semantic policy must independently authenticate and grant access.
  async function team(auth) {
    const a = authority(auth);
    const workspace = workspaceRegistry.get(a.workspaceId);
    if (!workspace || !(workspace.sessionIds instanceof Set) ||
        !workspace.sessionIds.has(a.leadSessionId)) deny();
    const projection = await sessionController.projections(
      { sessionId: a.leadSessionId }, new AbortController().signal
    );
    if (projection?.kind !== "sequenced" || !Number.isSafeInteger(projection.asOfSeq)) deny();
    const v = obj(projection.values?.agentTeam);
    if (v.failure !== undefined || !Array.isArray(v.members) ||
        !Array.isArray(v.tasks) || v.members.length < 1 ||
        v.members.length > 40 || v.tasks.length > 500) deny();
    const leads = v.members.filter(m =>
      m && m.id === a.leadSessionId && m.role === "lead" && m.phase === "active"
    );
    if (leads.length !== 1 || v.members.filter(m => m.role === "lead").length !== 1) deny();
    return { scope: a, view: v, asOfSeq: projection.asOfSeq };
  }

  return Object.freeze({
    async readAuthorizedTeam(auth) {
      const { scope, view, asOfSeq } = await team(auth);
      const members = view.members.map(m => ({
        id: id(m.id), role: m.role === "lead" ? "lead" : "teammate",
        name: scalarText(m.name, 120),
        phase: scalarText(m.phase, 32),
      }));
      const tasks = view.tasks.map(t => ({
        id: id(t.id), status: scalarText(t.status, 32),
        subject: scalarText(t.subject, 240),
        description: scalarText(t.description, 500),
      }));
      return { workspace_id: scope.workspaceId,
        lead_session_id: scope.leadSessionId, as_of_seq: asOfSeq,
        members, tasks };
    },

    async readAuthorizedChat(auth) {
      const { scope } = await team(auth);
      const limit = auth.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) deny();
      const inspected = await sessionController.inspect(
        scope.leadSessionId, new AbortController().signal
      );
      if (inspected?.meta?.id !== scope.leadSessionId ||
          !Array.isArray(inspected.events) || inspected.events.length > 30000) deny();
      // Only durable human/assistant messages; no tool arguments, internal
      // reasoning, prompt system/developer messages or unknown event fields.
      const messages = [];
      for (const event of inspected.events.slice(-2000)) {
        const isUser = event?.type === "user/message";
        if (!isUser && event?.type !== "assistant/message") continue;
        const message = isUser ? event.data : event.data?.message;
        if (!message || message.role !== (isUser ? "user" : "assistant") ||
            !Array.isArray(message.content)) continue;
        const parts = message.content.filter(p => p?.type === "text" &&
          typeof p.text === "string").map(p => p.text);
        if (!parts.length) continue;
        const text = parts.join("\n").slice(0, 1000);
        messages.push({ role: message.role, text });
        if (messages.length > 2000) deny();
      }
      return { workspace_id: scope.workspaceId,
        lead_session_id: scope.leadSessionId, messages: messages.slice(-limit) };
    },

    async commitAuthorizedInstruction(auth) {
      const { scope } = await team(auth);
      if (typeof auth.instruction !== "string" ||
          !auth.instruction.trim() ||
          Buffer.byteLength(auth.instruction, "utf8") > 4096 ||
          auth.instruction.includes("\0") ||
          typeof auth.idempotencyKey !== "string" ||
          !UUID.test(auth.idempotencyKey)) deny();

      // This callback is a required, trusted DB-backed *revocation-serialized*
      // grant + durable idempotency commit gate. It must hold authority while
      // the callback admits the DSH prompt, and return a persisted receipt.
      // No default permissive implementation is provided here.
      const receipt = await withAuthorizedLeadCommit(Object.freeze({
        ...scope, action: "lead.instruct", idempotencyKey: auth.idempotencyKey,
      }), async () => {
        await team(auth); // recheck exact Lead immediately before prompt admission
        const ack = await sessionController.prompt({
          requestId: dshRequestId(scope, auth.idempotencyKey),
          sessionId: scope.leadSessionId,
          mode: "queue",
          content: [{ type: "text", text: auth.instruction }],
        }, new AbortController().signal);
        if (ack?.accepted !== true) deny();
        return { accepted: true };
      });
      if (receipt?.accepted !== true ||
          receipt?.authorizationCheckedAtCommit !== true ||
          receipt?.grantRevision !== scope.revision ||
          typeof receipt?.messageId !== "string" || !ID.test(receipt.messageId) ||
          typeof receipt?.duplicate !== "boolean") deny();
      return {
        accepted: true,
        authorizationCheckedAtCommit: true,
        grantRevision: scope.revision,
        messageId: receipt.messageId,
        duplicate: receipt.duplicate,
      };
    },
  });
}
