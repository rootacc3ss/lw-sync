// IndexedDB-backed IndexBackend (renderer-native, incremental per-key writes). The index is
// a disposable cache — losing it just triggers a rebuild via Repair.

import { openDB, type IDBPDatabase } from "idb";
import type { IndexBackend, IndexRecord } from "./local-index";

const STORE = "index";

export class IdbIndexBackend implements IndexBackend {
  private dbp: Promise<IDBPDatabase>;

  constructor(dbName: string) {
    this.dbp = openDB(dbName, 1, {
      upgrade(db) {
        db.createObjectStore(STORE, { keyPath: "path" });
      },
    });
  }

  async get(path: string): Promise<IndexRecord | undefined> {
    return (await this.dbp).get(STORE, path) as Promise<IndexRecord | undefined>;
  }
  async put(rec: IndexRecord): Promise<void> {
    await (await this.dbp).put(STORE, rec);
  }
  async delete(path: string): Promise<void> {
    await (await this.dbp).delete(STORE, path);
  }
  async all(): Promise<IndexRecord[]> {
    return (await (await this.dbp).getAll(STORE)) as IndexRecord[];
  }
  async clear(): Promise<void> {
    await (await this.dbp).clear(STORE);
  }
}
