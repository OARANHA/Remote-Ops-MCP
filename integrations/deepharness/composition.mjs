/**
 * Compose the reviewed Remote-Ops per-session OAuth grant gate with the
 * pinned official DeepHarness SessionController host adapter.
 * This is NOT an MCP tool, HTTP listener, bridge deployment or grant store.
 * All dependencies must be trusted host-side capabilities.
 */
import { createDeepharnessSemanticPolicy } from "./semantic-policy.mjs";
import { createOfficialDshHostSessionBackend } from "./official-dsh-host-session.mjs";

export function composeDeepharnessReadWrite(deps = {}) {
  const host = createOfficialDshHostSessionBackend({
    sessionController: deps.sessionController,
    workspaceRegistry: deps.workspaceRegistry,
    withAuthorizedLeadCommit: deps.withAuthorizedLeadCommit,
  });
  return createDeepharnessSemanticPolicy({
    lookupCurrentGrant: deps.lookupCurrentGrant,
    readAuthorizedTeam: auth => host.readAuthorizedTeam(auth),
    readAuthorizedChat: auth => host.readAuthorizedChat(auth),
    commitAuthorizedInstruction: auth => host.commitAuthorizedInstruction(auth),
  });
}
