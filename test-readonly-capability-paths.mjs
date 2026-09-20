import { resolveCheckedGitRepo } from "./dist/security/paths.js";

const run = async (argv) => ({
  code: 0,
  stdout: String(argv.at(-1)) + "\n",
  stderr: "",
  durationMs: 1,
  truncated: false,
  timedOut: false,
});

const target = {
  id: "test",
  host: "example",
  port: 22,
  username: "ops",
  environment: "production",
  capabilityProfile: "read-only",
  allowedPaths: [],
  allowedDockerContainers: [],
  allowedServices: [],
  allowedGitRepos: ["/srv/repo"],
  enabled: true,
  transport: "agent",
  deviceId: "dev_abcdefgh",
};

const ok = await resolveCheckedGitRepo("/srv/repo", target, run);
if (ok !== "/srv/repo") throw new Error("allowed repo failed");
console.log("GIT_REPO_WITHOUT_ALLOWED_PATHS=PASS");

let denied = false;
try { await resolveCheckedGitRepo("/srv/other", target, run); } catch (e) { denied = String(e).includes("REPO_NOT_ALLOWED") || String(e).includes("allowlist"); }
if (!denied) throw new Error("outside repo unexpectedly allowed");
console.log("GIT_REPO_EXACT_ALLOWLIST=PASS");

denied = false;
try { await resolveCheckedGitRepo("/srv/repo/.git/config", target, run); } catch (e) { denied = true; }
if (!denied) throw new Error("secret path unexpectedly allowed");
console.log("GIT_REPO_SECRET_GUARD=PASS");

console.log("AGENT_READONLY_CAPABILITY_PATHS=GREEN");