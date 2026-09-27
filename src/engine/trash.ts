// Soft-delete: deletions move to Obsidian's trash, never a hard delete. History is also
// retained in the manifest (tombstone) and the object stays in the bucket, so a deleted
// file is always restorable. The user empties trash on their own schedule.

import type { VaultFS } from "./vault-fs";

export async function softDelete(fs: VaultFS, path: string): Promise<void> {
  if (await fs.exists(path)) await fs.trash(path);
}
