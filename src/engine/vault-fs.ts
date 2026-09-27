// The filesystem surface the sync engine needs. The runtime impl is backed by Obsidian's
// vault adapter + the adapter walker; tests use an in-memory implementation.

import type { WalkResult } from "./vault-walker";

export interface VaultFS {
  /**
   * Enumerate + classify every vault item. Returns both the covered entries and the
   * roster of excluded/unreadable items with reasons — the coverage audit trail.
   */
  walk(): Promise<WalkResult>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** Soft-delete: move to Obsidian trash (never a hard delete). */
  trash(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
