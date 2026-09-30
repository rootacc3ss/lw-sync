import { describe, test, expect } from "vitest";
import {
  SETUP_FILE,
  buildSetupDoc,
  serializeSetupDoc,
  parseSetupDoc,
  applySetupDoc,
  encryptSecrets,
  decryptSecrets,
  type SetupSettingsShape,
} from "../../src/portability";
import { generateKdfParams, type KdfParams } from "../../src/crypto/keys";

function lightKdf(): KdfParams {
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  return p;
}

function settings(): SetupSettingsShape {
  return {
    vaultName: "myvault",
    s3: {
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLEKEYID",
      bucket: "my-bucket",
      forcePathStyle: true,
      customHeaders: { "x-proxy-auth": "on" },
    },
    syncOnStart: true,
    syncOnSave: true,
    autoSyncMode: "live",
    autoSyncIntervalSec: 300,
    liveIdleSec: 5,
  };
}

describe("setup portability file", () => {
  test("plain doc carries connection + preferences, never a secrets block", () => {
    const doc = buildSetupDoc(settings(), null);
    expect(doc.secrets).toBeNull();
    expect(doc.s3.endpoint).toBe("https://s3.example.test");
    expect(doc.triggers.autoSyncMode).toBe("live");
    expect(doc.triggers.liveIdleSec).toBe(5);
    expect(SETUP_FILE).toBe("littlewooly-sync-setup.json");
  });

  test("serialize -> parse -> apply round-trips onto a fresh settings object", () => {
    const doc = parseSetupDoc(serializeSetupDoc(buildSetupDoc(settings(), null)));
    const target = settings();
    target.s3.endpoint = "https://old.example.test";
    target.vaultName = "old";
    target.syncOnSave = false;
    target.autoSyncMode = "off";

    applySetupDoc(target, doc);
    expect(target.s3.endpoint).toBe("https://s3.example.test");
    expect(target.vaultName).toBe("myvault");
    expect(target.s3.forcePathStyle).toBe(true);
    expect(target.s3.customHeaders).toEqual({ "x-proxy-auth": "on" });
    expect(target.syncOnSave).toBe(true);
    expect(target.autoSyncMode).toBe("live");
    expect(target.liveIdleSec).toBe(5);
  });

  test("a pre-0.4 doc with syncIntervalSec maps onto the new trigger fields", () => {
    const legacy = JSON.stringify({
      schema: 1,
      app: "littlewooly-sync",
      exportedAt: "2026-01-01T00:00:00.000Z",
      vaultName: "myvault",
      s3: settings().s3,
      triggers: { syncOnStart: true, syncOnSave: false, syncIntervalSec: 600 },
      secrets: null,
    });
    const target = settings();
    applySetupDoc(target, parseSetupDoc(legacy));
    expect(target.autoSyncMode).toBe("periodic");
    expect(target.autoSyncIntervalSec).toBe(600);
    expect(target.syncOnSave).toBe(false);

    const target2 = settings();
    applySetupDoc(target2, parseSetupDoc(legacy.replace('"syncIntervalSec":600', '"syncIntervalSec":0')));
    expect(target2.autoSyncMode).toBe("off");
  });

  test("a doc without custom headers clears the target's custom headers", () => {
    const s = settings();
    delete s.s3.customHeaders;
    const doc = parseSetupDoc(serializeSetupDoc(buildSetupDoc(s, null)));
    const target = settings();
    applySetupDoc(target, doc);
    expect(target.s3.customHeaders).toBeUndefined();
  });

  test("secrets: encrypted round-trip with the export passphrase; wrong one fails", async () => {
    const block = await encryptSecrets(
      "export-pass-123",
      { s3SecretAccessKey: "SUPER-SECRET-KEY", passphrase: "vault-pass-456" },
      lightKdf(),
    );
    expect(await decryptSecrets(block, "export-pass-123")).toEqual({
      s3SecretAccessKey: "SUPER-SECRET-KEY",
      passphrase: "vault-pass-456",
    });
    await expect(decryptSecrets(block, "wrong-pass")).rejects.toThrow(/export passphrase/i);
  });

  test("the exported file NEVER contains the raw secrets or passphrase in plaintext", async () => {
    const block = await encryptSecrets(
      "export-pass-123",
      { s3SecretAccessKey: "SUPER-SECRET-KEY", passphrase: "vault-pass-456" },
      lightKdf(),
    );
    const file = serializeSetupDoc(buildSetupDoc(settings(), block));
    expect(file).not.toContain("SUPER-SECRET-KEY");
    expect(file).not.toContain("vault-pass-456");
    // and it is still valid JSON that parses back
    expect(parseSetupDoc(file).secrets).not.toBeNull();
  });

  test("parseSetupDoc rejects foreign files", () => {
    expect(() => parseSetupDoc("not json at all")).toThrow();
    expect(() => parseSetupDoc(JSON.stringify({ app: "other", schema: 1, s3: {} }))).toThrow(
      /not a Little Wooly Sync setup file/i,
    );
    expect(() => parseSetupDoc(JSON.stringify({ app: "littlewooly-sync", schema: 9, s3: {} }))).toThrow(
      /not a Little Wooly Sync setup file/i,
    );
  });
});
