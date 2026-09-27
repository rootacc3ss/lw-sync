// Gathers the three sources of truth (live vault, merged manifest, bucket listing) into
// AuditInputs and runs the pure auditor. Used by the Coverage Audit command and by Repair.
//
// Deep audits additionally resolve every chunked file's recipe (fetch + decrypt) so that
// (a) a missing chunk is flagged as MISSING_OBJECT — a recipe whose chunk has gone missing
// is as unrestorable as a missing object — and (b) ORPHAN_OBJECT detection is accurate
// instead of being silently skipped.

import type { ObjectBackend } from "../store/backend";
import type { ManifestStore } from "../store/manifest-store";
import type { ObjectStore } from "../store/object-store";
import type { VaultFS } from "./vault-fs";
import { sha256, toHex } from "../crypto/object-cipher";
import {
  auditCoverage,
  type AuditInputs,
  type AuditReport,
  type HeadEntry,
} from "./coverage-auditor";

const SHARED_TIERS = new Set(["CONTENT", "SHARED_CONFIG"]);
/** Recipe fetches per batch during a deep audit — bounded so large vaults don't flood S3. */
const RECIPE_CONCURRENCY = 8;

function objectKeyFromPath(key: string): string {
  // objects/<fanout>/<objectKey>
  return key.slice(key.lastIndexOf("/") + 1);
}

export async function gatherAuditInputs(
  fs: VaultFS,
  manifests: ManifestStore,
  backend: ObjectBackend,
  objects: ObjectStore,
  opts: { deep: boolean },
): Promise<AuditInputs> {
  const { entries, roster } = await fs.walk();
  const live = [];
  for (const e of entries.filter((e) => SHARED_TIERS.has(e.tier))) {
    const hash = opts.deep ? toHex(await sha256(await fs.read(e.path))) : undefined;
    live.push({ path: e.path, size: e.size, hash });
  }

  const merged = await manifests.readMerged();
  const heads: Record<string, HeadEntry> = {};
  if (merged) {
    for (const [path, entry] of Object.entries(merged.paths)) {
      const h = entry.history[entry.head];
      if (!h) continue;
      heads[path] = {
        contentHash: h.contentHash,
        objectKey: h.objectKey,
        deleted: h.deleted,
        size: h.size,
        isRecipe: h.isRecipe,
      };
    }
  }

  const objectsList = await backend.list("objects/");
  const bucketObjectKeys = new Set(objectsList.map((o) => objectKeyFromPath(o.key)));
  const storedBytes = objectsList.reduce((sum, o) => sum + o.size, 0);

  // Deep audit: resolve recipe chunk keys (bounded concurrency). If a recipe itself is
  // missing/corrupt, chunkKeys stays empty — the head check above already flags the
  // missing recipe object as MISSING_OBJECT, so nothing passes silently.
  if (opts.deep) {
    const recipePaths = Object.keys(heads).filter((p) => heads[p].isRecipe && !heads[p].deleted);
    for (let i = 0; i < recipePaths.length; i += RECIPE_CONCURRENCY) {
      await Promise.all(
        recipePaths.slice(i, i + RECIPE_CONCURRENCY).map(async (p) => {
          try {
            heads[p].chunkKeys = await objects.getRecipeChunkKeys(heads[p].objectKey);
          } catch {
            heads[p].chunkKeys = [];
          }
        }),
      );
    }
  }

  // Orphan detection is only meaningful when chunk keys are known — deep audits only.
  let referencedObjectKeys: Set<string> | undefined;
  if (opts.deep) {
    referencedObjectKeys = new Set<string>();
    for (const h of Object.values(heads)) {
      if (h.deleted) continue;
      referencedObjectKeys.add(h.objectKey);
      for (const ck of h.chunkKeys ?? []) referencedObjectKeys.add(ck);
    }
  }

  return { live, heads, bucketObjectKeys, storedBytes, referencedObjectKeys, roster };
}

export async function runAudit(
  fs: VaultFS,
  manifests: ManifestStore,
  backend: ObjectBackend,
  objects: ObjectStore,
  opts: { deep: boolean } = { deep: true },
): Promise<AuditReport> {
  return auditCoverage(await gatherAuditInputs(fs, manifests, backend, objects, opts));
}
