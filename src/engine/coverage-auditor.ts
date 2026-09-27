// The headline feature: prove coverage by cross-checking three sources of truth —
// L (live vault), M (merged-manifest heads), S (actual bucket object listing) — and
// reconciling plaintext-vs-stored bytes so a suspicious compression ratio (the 800->300MB
// smell) is obvious. Read-only: it reports; remediation is the separate Repair step.

export type AuditBucket =
  | "MISSING_FROM_BACKUP"
  | "STALE_IN_BACKUP"
  | "MISSING_OBJECT"
  | "ORPHAN_OBJECT"
  | "MISSING_LOCALLY"
  | "TOMBSTONE_RESURRECTED";

export interface LiveEntry {
  path: string;
  size: number;
  /** plaintext hash; present in a deep audit, omitted in a fast (size/mtime) audit. */
  hash?: string;
}

export interface HeadEntry {
  contentHash: string;
  objectKey: string;
  deleted: boolean;
  size: number;
  /** set when the head points at a recipe object (chunked file). */
  isRecipe?: boolean;
  /**
   * Chunk object keys of a recipe head, resolved (fetch + decrypt) by the service during
   * a deep audit. When present, every chunk's presence in the bucket is verified.
   */
  chunkKeys?: string[];
}

export interface AuditInputs {
  live: LiveEntry[];
  heads: Record<string, HeadEntry>;
  /** object keys actually present under objects/ in the bucket. */
  bucketObjectKeys: Set<string>;
  /** total encrypted bytes stored under objects/. */
  storedBytes: number;
  /**
   * All object keys referenced by the manifest, INCLUDING recipe chunk keys. Used for
   * orphan detection; if omitted, orphan detection is skipped (avoids false positives for
   * chunked files whose chunk keys aren't in `heads`).
   */
  referencedObjectKeys?: Set<string>;
  /**
   * The walker roster: items excluded from coverage, each with its reason. Passed through
   * to the report so "nothing is dropped silently" is user-visible, not just internal.
   */
  roster?: { path: string; reason: string }[];
}

export interface AuditReport {
  findings: Record<AuditBucket, string[]>;
  criticalCount: number;
  plaintextBytes: number;
  storedBytes: number;
  ratio: number;
  verdict: string;
  /** Items excluded from coverage, with reasons (from the walker roster). */
  excluded: { path: string; reason: string }[];
}

const EMPTY = (): Record<AuditBucket, string[]> => ({
  MISSING_FROM_BACKUP: [],
  STALE_IN_BACKUP: [],
  MISSING_OBJECT: [],
  ORPHAN_OBJECT: [],
  MISSING_LOCALLY: [],
  TOMBSTONE_RESURRECTED: [],
});

export function auditCoverage(input: AuditInputs): AuditReport {
  const f = EMPTY();
  const liveByPath = new Map(input.live.map((e) => [e.path, e]));

  for (const e of input.live) {
    const head = input.heads[e.path];
    if (!head) {
      f.MISSING_FROM_BACKUP.push(e.path);
      continue;
    }
    if (head.deleted) {
      f.TOMBSTONE_RESURRECTED.push(e.path);
      continue;
    }
    if (e.hash !== undefined && e.hash !== head.contentHash) {
      f.STALE_IN_BACKUP.push(e.path);
    }
  }

  let plaintextBytes = 0;
  for (const [path, head] of Object.entries(input.heads)) {
    if (head.deleted) continue;
    plaintextBytes += head.size;
    if (!input.bucketObjectKeys.has(head.objectKey)) f.MISSING_OBJECT.push(path);
    if (head.chunkKeys) {
      const missing = head.chunkKeys.filter((ck) => !input.bucketObjectKeys.has(ck)).length;
      if (missing > 0) f.MISSING_OBJECT.push(`${path} (${missing} chunk${missing > 1 ? "s" : ""})`);
    }
    if (!liveByPath.has(path)) f.MISSING_LOCALLY.push(path);
  }

  if (input.referencedObjectKeys) {
    for (const key of input.bucketObjectKeys) {
      if (!input.referencedObjectKeys.has(key)) f.ORPHAN_OBJECT.push(key);
    }
  }

  for (const k of Object.keys(f) as AuditBucket[]) f[k].sort();

  const criticalCount = f.MISSING_FROM_BACKUP.length + f.MISSING_OBJECT.length;
  const ratio = plaintextBytes > 0 ? input.storedBytes / plaintextBytes : 0;
  const fileCount = Object.values(input.heads).filter((h) => !h.deleted).length;
  const verdict =
    criticalCount === 0
      ? `FULL COVERAGE VERIFIED: ${fileCount} files backed up, 0 critical findings`
      : `${criticalCount} CRITICAL finding(s): ${f.MISSING_FROM_BACKUP.length} not backed up, ${f.MISSING_OBJECT.length} missing objects`;

  return {
    findings: f,
    criticalCount,
    plaintextBytes,
    storedBytes: input.storedBytes,
    ratio,
    verdict,
    excluded: input.roster ?? [],
  };
}
