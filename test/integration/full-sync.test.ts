import { describe, test, expect, beforeAll } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Backend } from "../../src/store/s3-client";
import { PrefixedBackend } from "../../src/store/prefixed-backend";
import { ObjectStore } from "../../src/store/object-store";
import { ManifestStore } from "../../src/store/manifest-store";
import { LocalIndex, InMemoryIndexBackend } from "../../src/engine/local-index";
import { SyncEngine } from "../../src/engine/sync-engine";
import { Repair } from "../../src/engine/repair";
import { runAudit } from "../../src/engine/coverage-service";
import { MemoryVaultFS } from "../helpers/memory-vault-fs";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";
import {
  deriveSubkeys,
  deriveMasterKey,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";
import type { S3Config } from "../../src/types";

const cfg: S3Config = {
  endpoint: process.env.LWS_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "us-east-1",
  accessKeyId: process.env.LWS_S3_ACCESS_KEY ?? "minioadmin",
  secretAccessKey: process.env.LWS_S3_SECRET_KEY ?? "minioadmin",
  bucket: process.env.LWS_S3_BUCKET ?? "lws-test",
  forcePathStyle: true,
};

let reachable = false;
let subkeys: Subkeys;
let t = 1000;
const now = () => ++t;
const PREFIX = `lwsync/e2e-${Math.floor(Date.now() / 1000)}`;

beforeAll(async () => {
  const admin = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: cfg.bucket })).catch(() => {});
    await new S3Backend(cfg).testConnection();
    reachable = true;
  } catch {
    reachable = false;
  }
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
}, 30_000);

function device(name: string) {
  const backend = new PrefixedBackend(new S3Backend(cfg), PREFIX);
  const opts = makeClassifyOptions(defaultVaultConfig("e2e", name), "littlewooly-sync");
  const fs = new MemoryVaultFS(opts);
  const objects = new ObjectStore(backend, subkeys, 4096); // small chunks to exercise chunking
  const manifests = new ManifestStore(backend, subkeys.manifestKey);
  const index = new LocalIndex(new InMemoryIndexBackend());
  const engine = new SyncEngine(name, fs, objects, manifests, index, now);
  return { backend, fs, objects, manifests, index, engine };
}

describe("full sync over MinIO (two devices)", () => {
  test("create -> propagate -> audit clean -> delete -> repair, all against real S3", async () => {
    if (!reachable) return;

    const a = device("desktop");
    const b = device("mobile");

    a.fs.set("Notes/welcome.md", "hello wooly", 100);
    a.fs.set("big.bin", "x".repeat(10000), 100); // > chunk size -> recipe + chunks
    await a.engine.sync();

    // B connects and pulls everything.
    await b.engine.sync();
    expect(await b.fs.exists("Notes/welcome.md")).toBe(true);
    expect(new TextDecoder().decode(await b.fs.read("big.bin")).length).toBe(10000);

    // Coverage audit is clean on B.
    const report = await runAudit(b.fs, b.manifests, b.backend, b.objects);
    expect(report.criticalCount).toBe(0);
    expect(report.verdict).toMatch(/FULL COVERAGE/);

    // Delete on A propagates as a soft-delete (trash) on B.
    await a.fs.trash("Notes/welcome.md");
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.fs.exists("Notes/welcome.md")).toBe(false);
    expect(b.fs.trashed.has("Notes/welcome.md")).toBe(true);

    // Repair after wiping objects restores from the local copy with no data loss.
    for (const o of await a.backend.list("objects/")) await a.backend.delete(o.key);
    const repair = new Repair(a.engine, a.objects, a.index, a.fs, a.manifests, a.backend);
    const { after } = await repair.repair();
    expect(after.criticalCount).toBe(0);
    expect(await a.fs.exists("big.bin")).toBe(true);
  }, 30_000);
});
