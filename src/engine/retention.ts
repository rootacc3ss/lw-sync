// Optional deletion retention ("nothing is really deleted" — with an opt-in purge).
//
// Default (retentionDays = 0): nothing is EVER deleted from the bucket. Tombstones keep
// the history; objects are immutable and stay; a deleted file is always restorable.
//
// When the user opts into a purge window (retentionDays > 0): after the window passes,
// objects belonging to DELETED paths are removed from the bucket to bound its size.
// The collector is deliberately paranoid:
//   - a path is purgeable only if its head is a tombstone on EVERY device manifest
//     (any device with a live head — an edit or resurrection — vetoes the purge), and
//   - the newest tombstone must be older than the window, and
//   - every candidate object is cross-checked against all OTHER heads (live or still
//     inside their window): content-addressed chunks can be shared between files, so a
//     shared object is never deleted. A protected recipe that cannot be resolved vetoes
//     the whole purge (we cannot know which chunks it owns).
// Old versions of LIVE files are never touched — that's version history (V2).

import type { ObjectStore } from "../store/object-store";
import type { Manifest, HistoryRecord } from "../types";

const DAY_MS = 86_400_000;

export interface PurgeCandidate {
  path: string;
  objectKey: string;
  isRecipe: boolean;
}

/**
 * Pure: objects belonging to paths deleted everywhere, past the retention window.
 * Reads every device's LATEST manifest (the append-only logs stay untouched — purge
 * never rewrites history, it only removes unreferenced object blobs).
 */
export function collectPurgeable(
  manifests: Manifest[],
  now: number,
  retentionDays: number,
): PurgeCandidate[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * DAY_MS;

  // Latest head per path, per device that has the path.
  const heads = new Map<string, HistoryRecord[]>();
  for (const m of manifests) {
    for (const [path, entry] of Object.entries(m.paths)) {
      const h = entry.history[entry.head];
      if (!h) continue;
      const list = heads.get(path) ?? [];
      list.push(h);
      heads.set(path, list);
    }
  }

  const out = new Map<string, PurgeCandidate>();
  for (const [path, hs] of heads) {
    // Any live head (an edit or resurrection recorded on any device) vetoes the purge.
    if (!hs.every((h) => h.deleted)) continue;
    // The newest tombstone must have aged past the retention window.
    if (Math.max(...hs.map((h) => h.ts)) > cutoff) continue;
    // Tombstones carry the last live version's object key ("" if it never uploaded).
    for (const h of hs) {
      if (h.objectKey && !out.has(h.objectKey)) {
        out.set(h.objectKey, { path, objectKey: h.objectKey, isRecipe: h.isRecipe });
      }
    }
  }
  return [...out.values()];
}

/**
 * Delete purge-candidate objects, skipping anything referenced by another head.
 * `merged` is the current merged manifest (all paths EXCEPT the candidates' own).
 * Returns the number of objects deleted. Never throws on unreadable candidate recipes
 * (their top object is still deleted; orphaned chunks surface in the coverage audit);
 * but an unreadable PROTECTED recipe vetoes the whole purge (returns 0) — we cannot
 * know which chunks it owns, and a shared chunk must never be deleted.
 */
export async function applyPurge(
  objects: ObjectStore,
  candidates: PurgeCandidate[],
  merged: Manifest | null,
): Promise<number> {
  if (!candidates.length) return 0;

  const candidatePaths = new Set(candidates.map((c) => c.path));
  const protectedKeys = new Set<string>();
  if (merged) {
    for (const [path, entry] of Object.entries(merged.paths)) {
      const h = entry.history[entry.head];
      if (!h || !h.objectKey || candidatePaths.has(path)) continue;
      protectedKeys.add(h.objectKey);
      if (h.isRecipe) {
        try {
          for (const ck of await objects.getRecipeChunkKeys(h.objectKey)) {
            protectedKeys.add(ck);
          }
        } catch {
          return 0; // unknown chunks must be treated as possibly-shared — veto
        }
      }
    }
  }

  let purged = 0;
  for (const c of candidates) {
    const keys = [c.objectKey];
    if (c.isRecipe) {
      try {
        keys.push(...(await objects.getRecipeChunkKeys(c.objectKey)));
      } catch {
        // The recipe itself is a purge target; if it's unreadable we delete just it.
      }
    }
    for (const k of keys) {
      if (protectedKeys.has(k)) continue; // shared with a live/in-window head
      await objects.deleteObjectByKey(k);
      purged++;
    }
  }
  return purged;
}
