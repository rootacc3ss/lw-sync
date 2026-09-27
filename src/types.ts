// Shared types for Little Wooly Sync.
// Kept dependency-free so every layer (crypto, store, engine, ui) can import it.

/** The three coverage tiers plus exclusion. The classifier assigns exactly one. */
export type FileTier = "CONTENT" | "SHARED_CONFIG" | "DEVICE_CONFIG";

export type ClassifyResult = { tier: FileTier } | { tier: "EXCLUDE"; reason: string };

/** S3 / object-storage connection settings. Secrets stay device-local; never synced. */
export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** path-style (true, default) vs virtual-hosted (false). */
  forcePathStyle: boolean;
  /** Extra request headers for auth proxies/gateways (header name -> value). */
  customHeaders?: Record<string, string>;
}

/** One immutable, content-addressed encrypted blob in `objects/`. */
export interface ObjectRef {
  /** base32(HMAC(nameKey, sha256(plaintext))) — opaque, content-addressed. */
  objectKey: string;
  /** sha256 of the plaintext (hex). */
  contentHash: string;
  size: number;
}

/** A file too large for one object is split; the recipe lists its chunk keys in order. */
export interface Recipe {
  chunks: ObjectRef[];
  totalSize: number;
}

/** One entry in a path's append-only history. */
export interface HistoryRecord {
  version: number;
  /** Points at a single object, or a recipe object for chunked files. */
  objectKey: string;
  isRecipe: boolean;
  contentHash: string;
  size: number;
  mtime: number;
  /** human device name that authored this version. */
  author: string;
  ts: number;
  /** head the author started from — used to detect true concurrent edits. */
  parentHash: string | null;
  deleted: boolean;
}

export interface ManifestEntry {
  history: HistoryRecord[];
  head: number;
}

export interface Manifest {
  schema: number;
  generatedAt: number;
  device: string;
  paths: Record<string, ManifestEntry>;
}

/** Non-secret shared config persisted (encrypted) at `meta/vaultconfig`. */
export interface VaultConfig {
  schema: number;
  vaultName: string;
  devices: string[];
  /** user overrides: path/glob -> tier. */
  classificationOverrides: Record<string, FileTier | "EXCLUDE">;
  exclusionGlobs: string[];
  deviceConfigGlobs: string[];
  /**
   * Days a tombstoned (deleted) path's objects are kept before being purged from the
   * bucket. 0 = keep forever — the default; nothing is ever deleted. When > 0, purge
   * only ever touches paths whose head is a tombstone on EVERY device manifest, never
   * live files or their old versions.
   */
  retentionDays: number;
}

export const DEFAULT_DEVICE_CONFIG_GLOBS: string[] = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/graph.json",
];

export const DEFAULT_EXCLUSION_GLOBS: string[] = [".git/**", "node_modules/**", ".trash/**"];
