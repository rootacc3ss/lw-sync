import { describe, test, expect, beforeEach } from "vitest";
import { SyncEngine } from "../../src/engine/sync-engine";
import { Repair } from "../../src/engine/repair";
import { runAudit } from "../../src/engine/coverage-service";
import { ObjectStore } from "../../src/store/object-store";
import { ManifestStore } from "../../src/store/manifest-store";
import { LocalIndex, InMemoryIndexBackend } from "../../src/engine/local-index";
import { MemoryBackend } from "../helpers/memory-backend";
import { MemoryVaultFS } from "../helpers/memory-vault-fs";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";
import {
  deriveSubkeys,
  deriveMasterKey,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";

let bucket: MemoryBackend;
let subkeys: Subkeys;
let t = 1000;
const now = () => ++t;

beforeEach(async () => {
  bucket = new MemoryBackend();
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
});

function makeDevice() {
  const opts = makeClassifyOptions(defaultVaultConfig("v", "desktop"), "littlewooly-sync");
  const fs = new MemoryVaultFS(opts);
  const objects = new ObjectStore(bucket, subkeys);
  const manifests = new ManifestStore(bucket, subkeys.manifestKey);
  const index = new LocalIndex(new InMemoryIndexBackend());
  const engine = new SyncEngine("desktop", fs, objects, manifests, index, now);
  return { fs, objects, manifests, index, engine };
}

describe("Repair", () => {
  test("restores an object deleted from the bucket, using the local copy, with no data loss", async () => {
    const d = makeDevice();
    d.fs.set("Notes/keep.md", "important", 100);
    await d.engine.sync();

    // Simulate bucket corruption: wipe stored objects.
    for (const k of [...bucket.store.keys()]) if (k.startsWith("objects/")) bucket.store.delete(k);
    const before = await runAudit(d.fs, d.manifests, bucket, d.objects);
    expect(before.findings.MISSING_OBJECT.length).toBeGreaterThan(0);
    expect(before.criticalCount).toBeGreaterThan(0);

    const repair = new Repair(d.engine, d.objects, d.index, d.fs, d.manifests, bucket);
    const { after } = await repair.repair();

    expect(after.criticalCount).toBe(0);
    expect(after.verdict).toMatch(/FULL COVERAGE/);
    // the file is still present locally — repair never deleted anything
    expect(await d.fs.exists("Notes/keep.md")).toBe(true);
  });

  test("a healthy vault audits clean", async () => {
    const d = makeDevice();
    d.fs.set("a.md", "x", 100);
    d.fs.set("b.md", "y", 100);
    await d.engine.sync();
    const report = await runAudit(d.fs, d.manifests, bucket, d.objects);
    expect(report.criticalCount).toBe(0);
    expect(report.plaintextBytes).toBeGreaterThan(0);
  });
});
