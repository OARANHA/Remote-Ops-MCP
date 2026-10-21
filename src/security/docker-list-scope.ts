/** Filter Docker inventory metadata using the target's container allowlist. */
export function filterDockerListByAllowlist<T extends { name?: unknown }>(
  rows: readonly unknown[],
  allowlist: readonly string[] | null | undefined,
): T[] {
  if (!Array.isArray(rows) || !Array.isArray(allowlist)) return [];
  const names = new Set(allowlist.filter((value): value is string => typeof value === "string"));
  const wildcard = names.has("*");
  if (!wildcard && names.size === 0) return [];
  return rows.filter((row): row is T => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const name = (row as { name?: unknown }).name;
    return typeof name === "string" && (wildcard || names.has(name));
  });
}
