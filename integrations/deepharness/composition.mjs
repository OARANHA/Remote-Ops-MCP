/**
 * Compose the Remote-Ops per-session OAuth gate with the pinned official DSH
 * SessionController adapter. A durable grantStore may supply exact grant
 * lookup and revocation-serialized, persistent write receipts. This is still
 * not an MCP tool, HTTP listener, bridge deployment or identity provisioning
 * interface; all dependencies are trusted host-side capabilities.
 */
import { createDeepharnessSemanticPolicy } from "./semantic-policy.mjs";
import { createOfficialDshHostSessionBackend } from "./official-dsh-host-session.mjs";

export function composeDeepharnessReadWrite(deps = {}) {
  const grantStore = deps.grantStore;
  const lookupCurrentGrant = deps.lookupCurrentGrant ?? grantStore?.lookupCurrentGrant;
  const withAuthorizedLeadCommit = deps.withAuthorizedLeadCommit ?? grantStore?.withAuthorizedLeadCommit;
  const host = createOfficialDshHostSessionBackend({
    sessionController: deps.sessionController,
    workspaceRegistry: deps.workspaceRegistry,
    withAuthorizedLeadCommit,
  });
  return createDeepharnessSemanticPolicy({
    lookupCurrentGrant,
    readAuthorizedTeam: auth => host.readAuthorizedTeam(auth),
    readAuthorizedChat: auth => host.readAuthorizedChat(auth),
    commitAuthorizedInstruction: auth => host.commitAuthorizedInstruction(auth),
  });
}
