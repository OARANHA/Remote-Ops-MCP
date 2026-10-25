/**
 * Pure, read-only DeepHarness cleanup eligibility planner.
 * Does not authorize or perform mutations; intended for official DSH readback.
 */
import { createHash } from "node:crypto";

const deny = () => { throw new Error("deepharness_cleanup_plan_denied"); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const validId = x => typeof x === "string" && ID.test(x);
const validCount = x => Number.isSafeInteger(x) && x >= 0;
const unique = xs => new Set(xs).size === xs.length;

/**
 * Inventory must be collected through official APIs, with skill roots checked
 * from DSH's effective filesystem-skill provider configuration. Unknown or
 * incomplete skill inventory always blocks deletion.
 */
export function planDshCleanup(inventory) {
  if (!object(inventory) || inventory.complete !== true ||
      !Array.isArray(inventory.workspaces) || !object(inventory.skills) ||
      inventory.skills.complete !== true || !Array.isArray(inventory.skills.entries) ||
      inventory.skills.rootsComplete !== true) deny();
  if (inventory.workspaces.length > 1000 || inventory.skills.entries.length > 10000) deny();
  const skillPaths = new Set();
  for (const skill of inventory.skills.entries) {
    if (!object(skill) || typeof skill.path !== "string" || !skill.path.startsWith("/") ||
        !["project", "user", "custom", "bundled"].includes(skill.origin) ||
        typeof skill.workspaceId !== "string" && skill.workspaceId !== null ||
        skill.path.includes("\0") || skill.path.split("/").includes("..")) deny();
    if (skill.workspaceId !== null && !validId(skill.workspaceId)) deny();
    if (skillPaths.has(skill.path)) deny();
    skillPaths.add(skill.path);
  }
  const ids = [];
  const candidates = [];
  for (const workspace of inventory.workspaces) {
    if (!object(workspace) || !validId(workspace.id) ||
        !validCount(workspace.sessionCount) ||
        workspace.sessionsComplete !== true ||
        !["idle", "active", "unknown"].includes(workspace.activity) ||
        typeof workspace.skillRootsComplete !== "boolean") deny();
    ids.push(workspace.id);
    const projectSkills = inventory.skills.entries.some(skill => skill.workspaceId === workspace.id);
    const blockers = [];
    if (workspace.activity !== "idle") blockers.push("activity_not_idle");
    if (workspace.skillRootsComplete !== true) blockers.push("skills_not_fully_inventoried");
    if (projectSkills) blockers.push("project_skills_present");
    if (workspace.sessionCount !== 0) blockers.push("sessions_present");
    // Even a zero-blocker workspace is only eligible for a later verified
    // registry DEREGISTRATION, never directory deletion or session purge.
    candidates.push(Object.freeze({ workspaceId: workspace.id, sessionCount: workspace.sessionCount,
      projectSkillCount: inventory.skills.entries.filter(s => s.workspaceId === workspace.id).length,
      blockers, registryDeregistrationCandidate: blockers.length === 0,
      filesystemDeletionAllowed: false }));
  }
  if (!unique(ids) ||
      inventory.skills.entries.some(s => s.workspaceId !== null && !ids.includes(s.workspaceId))) deny();
  const normalized = candidates.sort((a,b) => a.workspaceId.localeCompare(b.workspaceId));
  const canonical = JSON.stringify({version:1,candidates:normalized});
  return Object.freeze({
    version:1,
    inventoryFingerprint:createHash("sha256").update(canonical).digest("hex"),
    workspaces:normalized,
    executionAuthorized:false,
    directoryDeletionAuthorized:false,
  });
}
