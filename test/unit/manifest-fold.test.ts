import { describe, test, expect } from "vitest";
import { foldManifests } from "../../src/store/manifest-store";
import type { Manifest, HistoryRecord } from "../../src/types";

function rec(p: Partial<HistoryRecord>): HistoryRecord {
  return {
    version: 0,
    objectKey: "k",
    isRecipe: false,
    contentHash: "h",
    size: 1,
    mtime: 1000,
    author: "dev",
    ts: 1000,
    parentHash: null,
    deleted: false,
    ...p,
  };
}

function manifest(device: string, paths: Record<string, HistoryRecord[]>): Manifest {
  const out: Manifest = { schema: 1, generatedAt: 0, device, paths: {} };
  for (const [path, history] of Object.entries(paths)) {
    out.paths[path] = { history, head: history.length - 1 };
  }
  return out;
}

describe("foldManifests", () => {
  test("unions disjoint paths from two devices", () => {
    const a = manifest("desktop", { "a.md": [rec({ contentHash: "ha" })] });
    const b = manifest("mobile", { "b.md": [rec({ contentHash: "hb" })] });
    const { merged } = foldManifests([a, b]);
    expect(Object.keys(merged.paths).sort()).toEqual(["a.md", "b.md"]);
  });

  test("last-writer-wins by mtime decides the head", () => {
    const a = manifest("desktop", {
      "n.md": [rec({ contentHash: "old", mtime: 100, parentHash: null })],
    });
    const b = manifest("mobile", {
      "n.md": [rec({ contentHash: "new", mtime: 200, parentHash: "old" })],
    });
    const { merged } = foldManifests([a, b]);
    const entry = merged.paths["n.md"];
    expect(entry.history.length).toBe(2); // both versions retained
    expect(entry.history[entry.head].contentHash).toBe("new");
  });

  test("flags a true conflict: same parent, divergent content", () => {
    const base = "base";
    const a = manifest("desktop", {
      "n.md": [rec({ contentHash: "editA", parentHash: base, author: "desktop" })],
    });
    const b = manifest("mobile", {
      "n.md": [rec({ contentHash: "editB", parentHash: base, author: "mobile" })],
    });
    const { conflicts } = foldManifests([a, b]);
    expect(conflicts.map((c) => c.path)).toContain("n.md");
  });

  test("a tombstone with the newest mtime makes the head a deletion", () => {
    const a = manifest("desktop", {
      "n.md": [rec({ contentHash: "live", mtime: 100 })],
    });
    const b = manifest("mobile", {
      "n.md": [rec({ deleted: true, mtime: 200, parentHash: "live" })],
    });
    const { merged } = foldManifests([a, b]);
    const entry = merged.paths["n.md"];
    expect(entry.history[entry.head].deleted).toBe(true);
  });

  test("does not mutate the input manifests", () => {
    const aRec = rec({ contentHash: "x", mtime: 100 });
    const bRec = rec({ contentHash: "y", mtime: 200 });
    const a = manifest("desktop", { "n.md": [aRec] });
    const b = manifest("mobile", { "n.md": [bRec] });
    const aBefore = JSON.stringify(a);
    const bBefore = JSON.stringify(b);
    foldManifests([a, b]);
    expect(JSON.stringify(a)).toBe(aBefore);
    expect(JSON.stringify(b)).toBe(bBefore);
    // and renumbering touches only the merged copies
    const { merged } = foldManifests([a, b]);
    expect(merged.paths["n.md"].history.map((r) => r.version)).toEqual([0, 1]);
    expect(aRec.version).toBe(0);
    expect(bRec.version).toBe(0);
  });

  test("is deterministic regardless of device input order", () => {
    const a = manifest("desktop", { "n.md": [rec({ contentHash: "x", mtime: 100 })] });
    const b = manifest("mobile", { "n.md": [rec({ contentHash: "y", mtime: 200 })] });
    const m1 = JSON.stringify(foldManifests([a, b]).merged.paths["n.md"]);
    const m2 = JSON.stringify(foldManifests([b, a]).merged.paths["n.md"]);
    expect(m1).toBe(m2);
  });
});
