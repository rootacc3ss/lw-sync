import { describe, test, expect } from "vitest";
import { LocalIndex, InMemoryIndexBackend, type IndexRecord } from "../../src/engine/local-index";

function rec(p: Partial<IndexRecord> = {}): Omit<IndexRecord, "deleted"> {
  return {
    path: "a.md",
    size: 10,
    mtime: 1000,
    contentHash: "h",
    objectKey: "k",
    isRecipe: false,
    tier: "CONTENT",
    lastSeen: 1,
    ...p,
  };
}

describe("LocalIndex dirty detection", () => {
  test("an unknown path is dirty", async () => {
    const idx = new LocalIndex(new InMemoryIndexBackend());
    expect(await idx.isDirty("new.md", 1, 1)).toBe(true);
  });

  test("an unchanged (size,mtime) path is clean", async () => {
    const idx = new LocalIndex(new InMemoryIndexBackend());
    await idx.markClean(rec({ size: 10, mtime: 1000 }));
    expect(await idx.isDirty("a.md", 10, 1000)).toBe(false);
  });

  test("a changed size or mtime is dirty", async () => {
    const idx = new LocalIndex(new InMemoryIndexBackend());
    await idx.markClean(rec({ size: 10, mtime: 1000 }));
    expect(await idx.isDirty("a.md", 11, 1000)).toBe(true);
    expect(await idx.isDirty("a.md", 10, 2000)).toBe(true);
  });

  test("clear() rebuilds from empty", async () => {
    const idx = new LocalIndex(new InMemoryIndexBackend());
    await idx.markClean(rec());
    expect((await idx.all()).length).toBe(1);
    await idx.clear();
    expect((await idx.all()).length).toBe(0);
  });
});
