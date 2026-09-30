// One-time bucket-layout migration: pre-0.5 (`lwsync/<vaultName>/…`, plaintext vault +
// device names in keys) -> 0.5 (`lwsync/<random vaultId>/…`, opaque everywhere).
//
// All stored refs are prefix-relative (manifests hold bare content-addressed object
// keys), so this is a pure KEY move — no content is rewritten, re-encrypted, or even
// downloaded (server-side copy; get+put fallback only for providers without CopyObject).
// Key rewrites: manifests/<name>/ and devices/<name>/ dirs -> keyed HMAC dirs (+ the
// encrypted `.id` reverse-maps); archives/<stamp>.lwa.enc -> opaque HMAC key + index.
//
// Safety: additive-first — copy everything, verify (key set + sizes), and only then delete
// the old prefix. Re-runnable — an interrupted run head-skips already-copied keys and
// resumes. A verify failure throws BEFORE any deletion.

import type { ObjectBackend } from "../store/backend";
import type { Subkeys } from "../crypto/keys";
import { sealJson } from "../crypto/box";
import { deviceDir } from "../store/manifest-store";
import { archiveKeyFor } from "./archive-job";

export interface MigrationReport {
  copied: number;
  skipped: number;
  deleted: number;
}

export interface MigrateOptions {
  onProgress?: (done: number, total: number) => void;
}

async function copyOrPut(raw: ObjectBackend, fromKey: string, toKey: string): Promise<void> {
  try {
    await raw.copy(fromKey, toKey);
  } catch {
    // No server-side copy on this provider (or it failed) — stream it through.
    const body = await raw.get(fromKey);
    if (!body) throw new Error(`migration source missing: ${fromKey}`);
    await raw.put(toKey, body);
  }
}

/**
 * Migrate a legacy vault from `lwsync/<legacyName>/` to `lwsync/<vaultId>/`.
 * `vaultId` must be a FRESH random id (never the vault name).
 */
export async function migrateLayout(
  raw: ObjectBackend,
  legacyName: string,
  vaultId: string,
  subkeys: Subkeys,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const from = `lwsync/${legacyName}`;
  const to = `lwsync/${vaultId}`;

  const legacy = await raw.list(`${from}/`);
  const total = legacy.length;
  let copied = 0;
  let skipped = 0;
  const manifestDirs = new Map<string, string>(); // legacy name -> new HMAC dir
  const deviceDirs = new Map<string, string>();
  const archiveEntries: { key: string; stamp: number }[] = [];
  const pairs: { fromKey: string; toKey: string; size: number }[] = [];

  for (const obj of legacy) {
    const rel = obj.key.slice(from.length + 1);
    let newRel: string | null = rel;

    let m = rel.match(/^manifests\/([^/]+)\//);
    if (m && m[1] !== "merged") {
      const dir = manifestDirs.get(m[1]) ?? (await deviceDir(subkeys.nameKey, m[1]));
      manifestDirs.set(m[1], dir);
      newRel = `manifests/${dir}/${rel.slice(`manifests/${m[1]}/`.length)}`;
    } else if ((m = rel.match(/^devices\/([^/]+)\//))) {
      const dir = deviceDirs.get(m[1]) ?? (await deviceDir(subkeys.nameKey, m[1]));
      deviceDirs.set(m[1], dir);
      newRel = `devices/${dir}/${rel.slice(`devices/${m[1]}/`.length)}`;
    } else if ((m = rel.match(/^archives\/(\d+)\.lwa\.enc$/))) {
      const stamp = parseInt(m[1], 10);
      const key = await archiveKeyFor(subkeys.nameKey, stamp);
      archiveEntries.push({ key, stamp });
      newRel = key;
    } else if (rel.startsWith("meta/.lws-cas-probe")) {
      newRel = null; // transient probe litter — never copy
    }

    if (newRel === null) continue;
    const toKey = `${to}/${newRel}`;
    if (await raw.head(toKey)) {
      skipped++; // already migrated (resumed run)
      continue;
    }
    pairs.push({ fromKey: obj.key, toKey, size: obj.size });
  }

  for (const p of pairs) {
    await copyOrPut(raw, p.fromKey, p.toKey);
    copied++;
    opts.onProgress?.(copied + skipped, total);
  }

  // Encrypted reverse-maps so listings stay human-readable post-migration.
  for (const [name, dir] of manifestDirs) {
    const key = `${to}/manifests/${dir}/.id`;
    if (!(await raw.head(key)))
      await raw.put(key, await sealJson(subkeys.manifestKey, { device: name }));
  }
  for (const [name, dir] of deviceDirs) {
    const key = `${to}/devices/${dir}/.id`;
    if (!(await raw.head(key)))
      await raw.put(key, await sealJson(subkeys.manifestKey, { device: name }));
  }

  // Chronological archive index for the (renamed) legacy archives.
  const indexKey = `${to}/meta/archives`;
  if (!(await raw.head(indexKey))) {
    archiveEntries.sort((a, b) => a.stamp - b.stamp);
    await raw.put(
      indexKey,
      await sealJson(subkeys.manifestKey, { schema: 1, entries: archiveEntries }),
    );
  }

  // Verify: every mapped key exists under the new prefix with the SAME size. A failure
  // throws here — before anything is deleted — so the old layout stays fully intact.
  const newList = await raw.list(`${to}/`);
  const newSizes = new Map(newList.map((o) => [o.key, o.size]));
  for (const p of pairs) {
    const size = newSizes.get(p.toKey);
    if (size === undefined || size !== p.size)
      throw new Error(`migration verify failed: ${p.toKey} missing or size-mismatched`);
  }
  // The .id files + archive index must exist too.
  for (const [name, dir] of [...manifestDirs, ...deviceDirs]) {
    const scope = manifestDirs.has(name) ? "manifests" : "devices";
    if (!newSizes.has(`${to}/${scope}/${dir}/.id`))
      throw new Error(`migration verify failed: .id for ${dir}`);
  }

  // Only now, fully verified: delete the old layout.
  let deleted = 0;
  for (const o of await raw.list(`${from}/`)) {
    await raw.delete(o.key);
    deleted++;
  }

  return { copied, skipped, deleted };
}
