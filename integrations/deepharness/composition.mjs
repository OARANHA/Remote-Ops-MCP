/**
 * Compose the Remote-Ops per-session OAuth gate with the pinned official DSH
 * SessionController adapter. A durable grantStore may supply exact grant
 * lookup and revocation-serialized, persistent write receipts. This is still
 * not an MCP tool, HTTP listener, bridge deployment or identity provisioning
 * interface; all dependencies are trusted host-side capabilities.
 */
import { createDeepharnessSemanticPolicy } from "./semantic-policy.mjs";
import { createOfficialDshHostSessionBackend } from "./official-dsh-host-session.mjs";
import { createRemoteDshPrivateBridgeBackend } from "./private-bridge-backend.mjs";
import {createDshMtlsRequester,createDshPrivateBridgeClient} from "./private-bridge-client.mjs";
import {createDshPrivateBridgeClientOverAgentMesh} from "./agent-mesh-semantic-client.mjs";

export function composeDeepharnessReadWrite(deps = {}) {
  const grantStore = deps.grantStore;
  const lookupCurrentGrant = deps.lookupCurrentGrant ?? grantStore?.lookupCurrentGrant;
  const withAuthorizedLeadCommit = deps.withAuthorizedLeadCommit ?? grantStore?.withAuthorizedLeadCommit;
  const host = deps.privateBridgeClient
    ? createRemoteDshPrivateBridgeBackend({client:deps.privateBridgeClient,withAuthorizedLeadCommit})
    : createOfficialDshHostSessionBackend({
      sessionController: deps.sessionController,
      workspaceRegistry: deps.workspaceRegistry,
      withAuthorizedLeadCommit,
    });
  return createDeepharnessSemanticPolicy({
    lookupCurrentGrant,
    listCurrentLeadGrants: grantStore?.listCurrentLeadGrants,
    readAuthorizedTeam: auth => host.readAuthorizedTeam(auth),
    readAuthorizedChat: auth => host.readAuthorizedChat(auth),
    commitAuthorizedInstruction: auth => host.commitAuthorizedInstruction(auth),
  });
}

/** Construct the private bridge client from operator-loaded TLS bytes and pin. */
export function composeDeepharnessReadWriteOverMtls({tls,serverFingerprintSha256,...deps}={}) {
  const postJson=createDshMtlsRequester({...tls,serverFingerprintSha256});
  const privateBridgeClient=createDshPrivateBridgeClient({postJson});
  return composeDeepharnessReadWrite({...deps,privateBridgeClient});
}

/**
 * Dedicated lab-only semantic Agent Mesh transport. The trusted registry
 * target is validated independently; OAuth/session grants are still checked
 * by the exact same persistent semantic policy on every read/write.
 */
export function composeDeepharnessReadWriteOverAgentMesh({
  target,lookupCurrentTarget,dispatchAgentOperation,...deps
}={}) {
  const privateBridgeClient=createDshPrivateBridgeClientOverAgentMesh({
    target,lookupCurrentTarget,dispatchAgentOperation,
  });
  return composeDeepharnessReadWrite({...deps,privateBridgeClient});
}
