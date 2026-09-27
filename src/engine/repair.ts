// The one-click "make everything correct" button. ADDITIVE and safe: it never deletes
// user data. It (1) re-ensures every live file's encrypted object exists in the bucket
// (recreating any that went missing, from the local copy — dedup makes present ones a
// no-op), then (2) rebuilds the local index and runs a sync to repair the manifest and pull
// anything MISSING_LOCALLY. A MISSING_OBJECT with no local copy is truly lost and is
// reported by the after-audit, never fabricated.

import type { ObjectBackend } from "../store/backend";
import type { ManifestStore } from "../store/manifest-store";
import type { ObjectStore } from "../store/object-store";
import type { LocalIndex } from "./local-index";
import type { VaultFS } from "./vault-fs";
import type { SyncEngine } from "./sync-engine";
import { runAudit } from "./coverage-service";
import type { AuditReport } from "./coverage-auditor";

export interface RepairResult {
  before: AuditReport;
  after: AuditReport;
  reuploaded: number;
}

const SHARED_TIERS = new Set(["CONTENT", "SHARED_CONFIG"]);

export class Repair {
  constructor(
    private engine: SyncEngine,
    private objects: ObjectStore,
    private index: LocalIndex,
    private fs: VaultFS,
    private manifests: ManifestStore,
    private backend: ObjectBackend,
  ) {}

  async repair(): Promise<RepairResult> {
    const before = await runAudit(this.fs, this.manifests, this.backend, this.objects, {
      deep: true,
    });

    // 1. Re-ensure every live file's object is present (recreates missing blobs from the
    //    local copy; putFile HEADs first so already-present objects cost nothing).
    let reuploaded = 0;
    for (const e of (await this.fs.walk()).entries) {
      if (!SHARED_TIERS.has(e.tier)) continue;
      await this.objects.putFile(await this.fs.read(e.path));
      reuploaded++;
    }

    // 2. Cold-rebuild the index and sync to repair manifest + pull anything missing locally.
    await this.index.clear();
    await this.engine.sync();

    const after = await runAudit(this.fs, this.manifests, this.backend, this.objects, {
      deep: true,
    });
    return { before, after, reuploaded };
  }
}
