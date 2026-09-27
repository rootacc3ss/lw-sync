// Device-local, rebuildable cache of last-synced state, keyed by path. Lets sync answer
// "did this change since last sync?" in O(1) and powers the coverage audit. It is NEVER
// the source of truth — losing it triggers a full rebuild from the manifest + a walk.
//
// Storage is pluggable (IndexBackend): IndexedDB at runtime (renderer), in-memory in tests.

import type { FileTier } from "../types";

export interface IndexRecord {
  path: string;
  size: number;
  mtime: number;
  contentHash: string;
  objectKey: string;
  isRecipe: boolean;
  tier: FileTier;
  /** scan generation this record was last confirmed present in. */
  lastSeen: number;
  deleted: boolean;
}

export interface IndexBackend {
  get(path: string): Promise<IndexRecord | undefined>;
  put(rec: IndexRecord): Promise<void>;
  delete(path: string): Promise<void>;
  all(): Promise<IndexRecord[]>;
  clear(): Promise<void>;
}

export class InMemoryIndexBackend implements IndexBackend {
  private map = new Map<string, IndexRecord>();
  async get(path: string) {
    return this.map.get(path);
  }
  async put(rec: IndexRecord) {
    this.map.set(rec.path, { ...rec });
  }
  async delete(path: string) {
    this.map.delete(path);
  }
  async all() {
    return [...this.map.values()].map((r) => ({ ...r }));
  }
  async clear() {
    this.map.clear();
  }
}

export class LocalIndex {
  constructor(private backend: IndexBackend) {}

  get(path: string): Promise<IndexRecord | undefined> {
    return this.backend.get(path);
  }
  put(rec: IndexRecord): Promise<void> {
    return this.backend.put(rec);
  }
  all(): Promise<IndexRecord[]> {
    return this.backend.all();
  }
  clear(): Promise<void> {
    return this.backend.clear();
  }

  /**
   * Cheap dirty check: a file whose (size, mtime) differs from the indexed record — or that
   * has no record — needs (re)uploading. mtime-preserving edits are caught separately by the
   * deep-rehash pass, which calls markClean with a fresh hash.
   */
  async isDirty(path: string, size: number, mtime: number): Promise<boolean> {
    const rec = await this.backend.get(path);
    if (!rec || rec.deleted) return true;
    return rec.size !== size || rec.mtime !== mtime;
  }

  /** Record a path as synced at the given stored ref + scan generation. */
  async markClean(rec: Omit<IndexRecord, "deleted">): Promise<void> {
    await this.backend.put({ ...rec, deleted: false });
  }
}
