import { describe, test, expect, beforeEach } from "vitest";
import { collectPurgeable, applyPurge, type PurgeCandidate } from "../../src/engine/retention";
import { ObjectStore } from "../../src/store/object-store";
import { MemoryBackend } from "../helpers/memory-backend";
import {
  deriveSubkeys,
  deriveMasterKey,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";
import type { Manifest, ManifestEntry, HistoryRecord } from "../../src/types";

const NOW = 1_000_000_000_000;
const THIRTY_DAYS = 30 * 86_400_000;

function rec(over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    version: 0,
    objectKey: "obj-a",
    isRecipe: false,
    contentHash: "ha",
    size: 10,
    mtime: 0,
    author: "desktop",
    ts: 0,
    parentHash: null,
    deleted: false,
    ...over,
  };
}

function manifest(device: string, paths: Record<string, HistoryRecord[]>): Manifest {
  const out: Record<string, ManifestEntry> = {};
  for (const [path, history] of Object.entries(paths)) {
    out[path] = { history, head: history.length - 1 };
  }
  return { schema: 1, generatedAt: 0, device, paths: out };
}

function mergedWith(heads: Record<string, HistoryRecord>): Manifest {
  const out: Record<string, ManifestEntry> = {};
  for (const [path, h] of Object.entries(heads)) {
    out[path] = { history: [h], head: 0 };
  }
  return { schema: 1, generatedAt: 0, device: "merged", paths: out };
}

describe("collectPurgeable", () => {
  test("retentionDays = 0 (keep forever) never collects anything", () => {
    const m = manifest("d", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: 0 })],
    });
    expect(collectPurgeable([m], NOW, 0)).toEqual([]);
  });

  test("tombstoned on every device, past the window -> candidate", () => {
    const a = manifest("desktop", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - THIRTY_DAYS - 5 })],
    });
    const b = manifest("mobile", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - THIRTY_DAYS - 5 })],
    });
    expect(collectPurgeable([a, b], NOW, 30)).toEqual([
      { path: "gone.md", objectKey: "k1", isRecipe: false },
    ]);
  });

  test("any device with a LIVE head vetoes the purge (edit/resurrection)", () => {
    const a = manifest("desktop", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - THIRTY_DAYS - 5 })],
    });
    const b = manifest("mobile", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - THIRTY_DAYS - 5 }),
                  rec({ deleted: false, objectKey: "k2", ts: NOW - 10 })],
    });
    expect(collectPurgeable([a, b], NOW, 30)).toEqual([]);
  });

  test("a tombstone still inside the window is not collectable", () => {
    const a = manifest("d", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - 1000 })],
    });
    expect(collectPurgeable([a], NOW, 30)).toEqual([]);
  });

  test("distinct tombstone object keys across devices are all collected", () => {
    const a = manifest("desktop", {
      "gone.md": [rec({ deleted: true, objectKey: "k1", ts: NOW - THIRTY_DAYS - 5 })],
    });
    const b = manifest("mobile", {
      "gone.md": [rec({ deleted: true, objectKey: "k2", ts: NOW - THIRTY_DAYS - 5 })],
    });
    const out = collectPurgeable([a, b], NOW, 30);
    expect(out.map((c) => c.objectKey).sort()).toEqual(["k1", "k2"]);
  });

  test("a tombstone for a never-uploaded path (empty objectKey) is skipped", () => {
    const a = manifest("d", {
      "gone.md": [rec({ deleted: true, objectKey: "", ts: NOW - THIRTY_DAYS - 5 })],
    });
    expect(collectPurgeable([a], NOW, 30)).toEqual([]);
  });
});

describe("applyPurge", () => {
  let be: MemoryBackend;
  let subkeys: Subkeys;
  let objects: ObjectStore;

  beforeEach(async () => {
    be = new MemoryBackend();
    const p = generateKdfParams();
    p.memoryKiB = 8192;
    p.iterations = 1;
    subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
    objects = new ObjectStore(be, subkeys);
  });

  test("deletes the candidate object, keeps everything else referenced", async () => {
    const gone = await objects.putFile(new TextEncoder().encode("gone"));
    const kept = await objects.putFile(new TextEncoder().encode("kept"));
    const candidates: PurgeCandidate[] = [
      { path: "gone.md", objectKey: gone.objectKey, isRecipe: false },
    ];
    const merged = mergedWith({ "keep.md": rec({ objectKey: kept.objectKey, contentHash: "hk" }) });

    const purged = await applyPurge(objects, candidates, merged);
    expect(purged).toBe(1);
    expect(await be.get(`objects/${gone.objectKey.slice(0, 2)}/${gone.objectKey}`)).toBeNull();
    expect(await be.get(`objects/${kept.objectKey.slice(0, 2)}/${kept.objectKey}`)).not.toBeNull();
  });

  test("an object shared with a live head (convergent dedup) is never deleted", async () => {
    const same = new TextEncoder().encode("identical content");
    const gone = await objects.putFile(same);
    const kept = await objects.putFile(same);
    expect(gone.objectKey).toBe(kept.objectKey); // convergent: same content, same object

    const candidates: PurgeCandidate[] = [
      { path: "gone.md", objectKey: gone.objectKey, isRecipe: false },
    ];
    const merged = mergedWith({ "keep.md": rec({ objectKey: kept.objectKey, contentHash: "hk" }) });

    expect(await applyPurge(objects, candidates, merged)).toBe(0);
    expect(await be.get(`objects/${kept.objectKey.slice(0, 2)}/${kept.objectKey}`)).not.toBeNull();
  });

  test("recipe candidates take their chunks with them", async () => {
    const chunked = new ObjectStore(be, subkeys, 16); // tiny chunks
    // 40 DISTINCT bytes -> 3 distinct chunks (16+16+8) + 1 recipe = 4 objects.
    const data = Uint8Array.from({ length: 40 }, (_, i) => i);
    const stored = await chunked.putFile(data);
    expect((await be.list("objects/")).length).toBe(4);

    const candidates: PurgeCandidate[] = [
      { path: "big.bin", objectKey: stored.objectKey, isRecipe: true },
    ];
    expect(await applyPurge(chunked, candidates, null)).toBe(4); // recipe + 3 chunks
    expect((await be.list("objects/")).length).toBe(0);
  });

  test("an unreadable PROTECTED recipe vetoes the whole purge (shared chunks unknown)", async () => {
    const target = await objects.putFile(new TextEncoder().encode("target"));
    const candidates: PurgeCandidate[] = [
      { path: "gone.md", objectKey: target.objectKey, isRecipe: false },
    ];
    const merged = mergedWith({
      "keep.bin": rec({ objectKey: "missing-recipe", isRecipe: true, contentHash: "h" }),
    });

    expect(await applyPurge(objects, candidates, merged)).toBe(0);
    expect(await be.get(`objects/${target.objectKey.slice(0, 2)}/${target.objectKey}`)).not.toBeNull();
  });
});
