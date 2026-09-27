import { describe, test, expect, beforeAll } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Backend } from "../../src/store/s3-client";
import { PrefixedBackend } from "../../src/store/prefixed-backend";
import { ObjectStore } from "../../src/store/object-store";
import { PreconditionFailedError } from "../../src/store/backend";
import { deriveSubkeys, deriveMasterKey, generateKdfParams } from "../../src/crypto/keys";
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
let backend: S3Backend;

beforeAll(async () => {
  backend = new S3Backend(cfg);
  const admin = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: cfg.bucket })).catch(() => {});
    await backend.testConnection();
    reachable = true;
  } catch {
    reachable = false;
  }
}, 30_000);

describe("S3Backend against MinIO", () => {
  test("put / head / get / list / delete round-trip", async () => {
    if (!reachable) return; // skip when no MinIO is running
    const enc = new TextEncoder();
    await backend.put("meta/hello", enc.encode("world"));
    expect((await backend.head("meta/hello"))?.size).toBe(5);
    expect(new TextDecoder().decode((await backend.get("meta/hello"))!)).toBe("world");
    expect((await backend.list("meta/")).some((i) => i.key === "meta/hello")).toBe(true);
    await backend.delete("meta/hello");
    expect(await backend.head("meta/hello")).toBeNull();
    expect(await backend.get("meta/missing")).toBeNull();
  });

  test("conditional create (If-None-Match) is honored", async () => {
    if (!reachable) return;
    const k = "meta/cond";
    await backend.delete(k).catch(() => {});
    await backend.put(k, new Uint8Array([1]), { ifNoneMatch: true });
    await expect(backend.put(k, new Uint8Array([2]), { ifNoneMatch: true })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await backend.delete(k);
  });

  test("ObjectStore stores & restores an encrypted file end-to-end", async () => {
    if (!reachable) return;
    const p = generateKdfParams();
    p.memoryKiB = 8192;
    p.iterations = 1;
    const subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
    const store = new ObjectStore(new PrefixedBackend(backend, "lwsync/itest"), subkeys, 1024);

    const plaintext = new Uint8Array(4096).map((_, i) => (i * 7) & 0xff);
    const ref = await store.putFile(plaintext);
    expect(ref.isRecipe).toBe(true); // 4096 > 1024 chunk size
    const out = await store.getFile(ref);
    expect(new Uint8Array(out)).toEqual(plaintext);

    // The bucket must reveal no plaintext: object keys are opaque, bodies encrypted.
    const listed = await backend.list("lwsync/itest/objects/");
    expect(listed.length).toBeGreaterThan(0);
    for (const o of listed) {
      const body = await backend.get(o.key);
      expect(new TextDecoder().decode(body!.slice(0, 4))).toBe("LWS1"); // encrypted blob magic
    }
  });
});
