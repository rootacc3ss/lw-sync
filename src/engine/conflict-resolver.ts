// Conflict handling. Default is last-writer-wins for the manifest head, but the losing
// version is NEVER lost: it is written beside the original as a conflict copy (itself a
// tracked file, so every device ends up with both). Structured .json gets a 3-way merge
// attempt first.

function isoStamp(ts: number): string {
  // 2026-06-15T00-00-00 (filesystem-safe; no colons).
  return new Date(ts).toISOString().replace(/:/g, "-").replace(/\..*$/, "");
}

export function conflictCopyName(path: string, fromDevice: string, ts: number): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem} (conflict copy from ${fromDevice} ${isoStamp(ts)})${ext}`;
}

export function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}

type Json = Record<string, unknown>;

/**
 * 3-way merge of flat-ish JSON objects. Returns the merged object, or null if both sides
 * changed the same key to different values (a real conflict the caller resolves via a copy).
 */
export function mergeJson3(base: Json, mine: Json, theirs: Json): Json | null {
  const result: Json = { ...base };
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  for (const k of keys) {
    const b = JSON.stringify(base[k]);
    const m = JSON.stringify(mine[k]);
    const t = JSON.stringify(theirs[k]);
    const mineChanged = m !== b;
    const theirsChanged = t !== b;
    if (mineChanged && theirsChanged && m !== t) return null; // true conflict
    if (theirsChanged) result[k] = theirs[k];
    else if (mineChanged) result[k] = mine[k];
    if (m === undefined && t === undefined) delete result[k];
  }
  return result;
}
