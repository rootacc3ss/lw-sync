// Runtime VaultFS: enumerates via the adapter walker (DataAdapter sees hidden files and
// .obsidian/ on desktop AND mobile, so coverage stays total), and reads/writes/trashes
// through the same adapter so Obsidian stays consistent. No Node APIs — the
// FileSystemAdapter cast would crash on mobile, where the adapter is a CapacitorAdapter.
// Soft-delete uses the adapter's local trash (.trash).

import type { App, DataAdapter } from "obsidian";
import type { VaultFS } from "./vault-fs";
import { walkVault, type WalkResult } from "./vault-walker";
import type { ClassifyOptions } from "./file-classifier";

export class ObsidianVaultFS implements VaultFS {
  private adapter: DataAdapter;

  constructor(
    app: App,
    private opts: ClassifyOptions,
    /** Notified of every path this class writes/mkdirs/trashes (sync self-writes, so the
     *  plugin's vault-event handlers can tell them apart from real user edits). */
    private onWrite?: (path: string) => void,
  ) {
    this.adapter = app.vault.adapter;
  }

  async walk(): Promise<WalkResult> {
    return walkVault(this.adapter, this.opts);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.ensureDir(path);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(path, ab);
    this.onWrite?.(path);
  }

  async trash(path: string): Promise<void> {
    // local trash (.trash in the vault) — soft delete, recoverable by the user.
    await this.adapter.trashLocal(path);
    this.onWrite?.(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  private async ensureDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash < 0) return;
    const dir = filePath.slice(0, slash);
    const segments = dir.split("/");
    let cur = "";
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!(await this.adapter.exists(cur))) {
        await this.adapter.mkdir(cur);
        this.onWrite?.(cur);
      }
    }
  }
}
