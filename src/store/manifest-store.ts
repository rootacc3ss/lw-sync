// Manifest persistence + the deterministic multi-device fold.
//
// Source of truth = per-device manifests at `manifests/<dir>/<seq>.manifest` (a device
// only ever writes its own namespace, so no device can clobber another). `<dir>` is the
// keyed HMAC of the device name — opaque to the bucket operator (names live encrypted
// inside the manifest content and the per-dir `.id` file). The merged manifest at
// `manifests/merged/<seq>.manifest` is DERIVED by folding all device manifests and
// advanced via conditional-PUT CAS; if a backend ignores the precondition it is still
// fully rebuildable from the device manifests, so a lost race costs only a recompute.

import { ObjectBackend, PreconditionFailedError } from "./backend";
import { sealJson, openJson } from "../crypto/box";
import { hmacSha256, base32 } from "../crypto/object-cipher";
import type { Manifest, ManifestEntry, HistoryRecord } from "../types";

const enc = new TextEncoder();

/** Opaque, deterministic dir name for a device (keyed HMAC — bucket-safe). */
export async function deviceDir(nameKey: Uint8Array, device: string): Promise<string> {
  return base32(await hmacSha256(nameKey, enc.encode(device)));
}

export interface ConflictInfo {
  path: string;
  contentHashes: string[];
}

export interface FoldResult {
  merged: Manifest;
  conflicts: ConflictInfo[];
}

function recordId(r: HistoryRecord): string {
  return `${r.contentHash}|${r.deleted ? 1 : 0}|${r.ts}|${r.author}`;
}

function ordering(a: HistoryRecord, b: HistoryRecord): number {
  return a.mtime - b.mtime || a.ts - b.ts || a.author.localeCompare(b.author);
}

/** Pure: fold per-device manifests into one merged manifest + a list of true conflicts. */
export function foldManifests(manifests: Manifest[]): FoldResult {
  const byPath = new Map<string, HistoryRecord[]>();
  for (const m of manifests) {
    for (const [path, entry] of Object.entries(m.paths)) {
      const list = byPath.get(path) ?? [];
      list.push(...entry.history);
      byPath.set(path, list);
    }
  }

  const merged: Manifest = { schema: 1, generatedAt: 0, device: "merged", paths: {} };
  const conflicts: ConflictInfo[] = [];

  for (const [path, records] of byPath) {
    // Dedup identical records, copy them (folding must never mutate the caller's
    // manifests), then order deterministically (LWW = last) and renumber.
    const seen = new Map<string, HistoryRecord>();
    for (const r of records) seen.set(recordId(r), r);
    const history = [...seen.values()].map((r) => ({ ...r })).sort(ordering);
    history.forEach((r, i) => (r.version = i));

    const entry: ManifestEntry = { history, head: history.length - 1 };
    merged.paths[path] = entry;

    // True conflict: divergent live content sharing one parent.
    const byParent = new Map<string, Set<string>>();
    for (const r of history) {
      if (r.deleted) continue;
      const set = byParent.get(r.parentHash ?? "∅") ?? new Set<string>();
      set.add(r.contentHash);
      byParent.set(r.parentHash ?? "∅", set);
    }
    for (const [, hashes] of byParent) {
      if (hashes.size > 1) {
        conflicts.push({ path, contentHashes: [...hashes] });
        break;
      }
    }
  }

  return { merged, conflicts };
}

function seqOf(key: string): number {
  const m = key.match(/\/(\d+)\.manifest$/);
  return m ? parseInt(m[1], 10) : -1;
}

/** Encrypted persistence over an ObjectBackend (already vault-prefixed by the caller). */
export class ManifestStore {
  constructor(
    private backend: ObjectBackend,
    private manifestKey: Uint8Array,
    private nameKey: Uint8Array,
  ) {}

  private async readManifestAt(key: string): Promise<Manifest | null> {
    const blob = await this.backend.get(key);
    if (!blob) return null;
    return openJson<Manifest>(this.manifestKey, blob);
  }

  /** Encrypted reverse-map: dir hash -> device name, so listings stay human-readable. */
  private async ensureId(dir: string, device: string): Promise<void> {
    const key = `manifests/${dir}/.id`;
    if (await this.backend.head(key)) return;
    await this.backend.put(key, await sealJson(this.manifestKey, { device }));
  }

  /** Latest manifest seq for a device dir, or -1 if none. */
  private async latestSeq(prefix: string): Promise<number> {
    const objs = await this.backend.list(prefix);
    return objs.reduce((max, o) => Math.max(max, seqOf(o.key)), -1);
  }

  /** Append this device's current manifest snapshot as the next seq. */
  async writeDeviceManifest(device: string, manifest: Manifest): Promise<void> {
    const dir = await deviceDir(this.nameKey, device);
    await this.ensureId(dir, device);
    const prefix = `manifests/${dir}/`;
    const next = (await this.latestSeq(prefix)) + 1;
    const blob = await sealJson(this.manifestKey, manifest);
    await this.backend.put(`${prefix}${next}.manifest`, blob);
  }

  async readDeviceLatest(device: string): Promise<Manifest | null> {
    const dir = await deviceDir(this.nameKey, device);
    return this.readDirLatest(dir);
  }

  /** Latest manifest of a dir (dirs are the opaque device hashes). */
  async readDirLatest(dir: string): Promise<Manifest | null> {
    const prefix = `manifests/${dir}/`;
    const seq = await this.latestSeq(prefix);
    if (seq < 0) return null;
    return this.readManifestAt(`${prefix}${seq}.manifest`);
  }

  /** All device dirs that have ever written a manifest (excludes `merged`). */
  async listManifestDirs(): Promise<string[]> {
    const objs = await this.backend.list("manifests/");
    const dirs = new Set<string>();
    for (const o of objs) {
      const m = o.key.match(/^manifests\/([^/]+)\/\d+\.manifest$/);
      if (m && m[1] !== "merged") dirs.add(m[1]);
    }
    return [...dirs];
  }

  /** All device NAMES that have ever written a manifest (via the encrypted `.id`s). */
  async listDevices(): Promise<string[]> {
    const out: string[] = [];
    for (const dir of await this.listManifestDirs()) {
      const blob = await this.backend.get(`manifests/${dir}/.id`);
      if (!blob) continue; // no reverse-map (shouldn't happen) — skip, folding uses dirs
      try {
        out.push((await openJson<{ device: string }>(this.manifestKey, blob)).device);
      } catch {
        /* corrupt .id — skip */
      }
    }
    return out;
  }

  /** Read & fold every device manifest into the current merged view. */
  async computeMerged(): Promise<FoldResult> {
    const dirs = await this.listManifestDirs();
    const manifests: Manifest[] = [];
    for (const d of dirs) {
      const m = await this.readDirLatest(d);
      if (m) manifests.push(m);
    }
    return foldManifests(manifests);
  }

  /** Advance the merged pointer via CAS; safe to lose (merged is derivable). */
  async advanceMerged(merged: Manifest): Promise<void> {
    const next = (await this.latestSeq("manifests/merged/")) + 1;
    const blob = await sealJson(this.manifestKey, merged);
    try {
      await this.backend.put(`manifests/merged/${next}.manifest`, blob, { ifNoneMatch: true });
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
      // Another device advanced merged first; ours is derivable, so just move on.
    }
  }

  async readMerged(): Promise<Manifest | null> {
    const seq = await this.latestSeq("manifests/merged/");
    if (seq < 0) return null;
    return this.readManifestAt(`manifests/merged/${seq}.manifest`);
  }
}
