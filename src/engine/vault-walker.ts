// Authoritative enumeration of EVERY item in the vault via Obsidian's DataAdapter
// (`list` + `stat`). Works identically on desktop (FileSystemAdapter) and mobile
// (CapacitorAdapter) — no Node fs anywhere. The adapter layer sees hidden files,
// dotfolders, and `.obsidian/`, so coverage stays total. Records each path with its
// tier, or with an exclusion reason — nothing is dropped silently.
//
// Caveat: the adapter follows symlinks without reporting them, so symlinked folders are
// walked as normal folders. A visited-set guards against infinite symlink cycles.

import { classify, type ClassifyOptions } from "./file-classifier";
import type { FileTier } from "../types";

export interface WalkEntry {
  path: string; // vault-relative, forward-slash
  tier: FileTier;
  size: number;
  mtime: number;
}

export interface RosterItem {
  path: string;
  reason: string;
}

export interface WalkResult {
  entries: WalkEntry[];
  roster: RosterItem[];
}

/** The slice of Obsidian's DataAdapter the walker needs (structurally compatible). */
export interface WalkAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime: number; size: number; type: string } | null>;
}

/** Strip a single leading slash so listed children classify as vault-relative paths. */
function rel(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

export async function walkVault(adapter: WalkAdapter, opts: ClassifyOptions): Promise<WalkResult> {
  const entries: WalkEntry[] = [];
  const roster: RosterItem[] = [];
  const visitedDirs = new Set<string>();

  async function walk(dir: string): Promise<void> {
    if (visitedDirs.has(dir)) return; // symlink/alias cycle guard
    visitedDirs.add(dir);

    let listed: { files: string[]; folders: string[] };
    try {
      listed = await adapter.list(dir);
    } catch {
      // Unreadable dir: record as unknown, never as "absent" (protects against
      // spurious deletions in the audit).
      roster.push({ path: dir ? dir + "/" : "/", reason: "list failed (unknown, not skipped)" });
      return;
    }

    for (const folder of listed.folders) {
      const path = rel(folder);
      const c = classify(path, opts);
      if (c.tier === "EXCLUDE") {
        roster.push({ path: path + "/", reason: c.reason });
        continue;
      }
      await walk(path);
    }

    for (const file of listed.files) {
      const path = rel(file);
      const c = classify(path, opts);
      if (c.tier === "EXCLUDE") {
        roster.push({ path, reason: c.reason });
        continue;
      }
      let st: { mtime: number; size: number; type: string } | null = null;
      try {
        st = await adapter.stat(path);
      } catch {
        st = null;
      }
      if (!st || st.type !== "file") {
        roster.push({ path, reason: "stat failed or not a regular file (unknown, not skipped)" });
        continue;
      }
      entries.push({ path, tier: c.tier, size: st.size, mtime: Math.floor(st.mtime) });
    }
  }

  await walk("");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  roster.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, roster };
}
