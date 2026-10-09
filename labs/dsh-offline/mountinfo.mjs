/**
 * Inspect the effective / mount options inside this Linux mount namespace.
 * A failed write under /etc is not evidence of a read-only root filesystem:
 * a non-root UID can receive EACCES even on a writable mount.
 */
export function rootMountIsReadOnly(mountinfo) {
  if (typeof mountinfo !== "string") return false;
  const mounts = [];
  for (const line of mountinfo.split("\n")) {
    const delimiter = line.indexOf(" - ");
    if (delimiter < 0) continue;
    const fields = line.slice(0, delimiter).trim().split(/\s+/);
    // mountinfo: id parent major:minor root mount-point mount-options ...
    if (fields.length < 6 || fields[4] !== "/") continue;
    const opts = fields[5].split(",");
    mounts.push(opts.includes("ro") && !opts.includes("rw"));
  }
  // Fail closed for ambiguous or missing root mount records.
  return mounts.length === 1 && mounts[0] === true;
}
