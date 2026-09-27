// Setup portability: move your setup to a new device via a JSON file in the vault root.
//
// The file carries connection settings + preferences — and, ONLY if the user opts in,
// a secrets block sealed with a one-time export passphrase (fresh Argon2id → HKDF →
// AES-GCM, the same crypto stack as everything else). The raw S3 secret / vault
// passphrase are never written to the file in plaintext.
//
// Pure module: no obsidian imports, fully unit-testable.

import { generateKdfParams, deriveMasterKey, deriveSubkeys, type KdfParams } from "./crypto/keys";
import { sealJson, openJson } from "./crypto/box";
import { b64encode, b64decode } from "./crypto/bytes";

export const SETUP_FILE = "littlewooly-sync-setup.json";

/** The settings surface that is exported/imported (LwsSettings is structurally this). */
export interface SetupSettingsShape {
  vaultName: string;
  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    bucket: string;
    forcePathStyle: boolean;
    customHeaders?: Record<string, string>;
  };
  syncOnStart: boolean;
  syncOnSave: boolean;
  syncIntervalSec: number;
}

export interface SetupSecretsBlock {
  kdf: KdfParams;
  /** base64(sealJson(verifyKey, { s3SecretAccessKey, passphrase })) */
  sealed: string;
}

export interface SetupDoc {
  schema: 1;
  app: "littlewooly-sync";
  exportedAt: string;
  vaultName: string;
  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    bucket: string;
    forcePathStyle: boolean;
    customHeaders?: Record<string, string>;
  };
  triggers: { syncOnStart: boolean; syncOnSave: boolean; syncIntervalSec: number };
  secrets: SetupSecretsBlock | null;
}

/** Seal the secrets with a one-time export passphrase (fresh derivation). */
export async function encryptSecrets(
  exportPass: string,
  secrets: { s3SecretAccessKey: string; passphrase: string },
  params: KdfParams = generateKdfParams(),
): Promise<SetupSecretsBlock> {
  const subkeys = await deriveSubkeys(await deriveMasterKey(exportPass, params));
  const sealed = await sealJson(subkeys.verifyKey, secrets);
  return { kdf: params, sealed: b64encode(sealed) };
}

/** Open the secrets block. Throws on a wrong passphrase (GCM auth fails). */
export async function decryptSecrets(
  block: SetupSecretsBlock,
  exportPass: string,
): Promise<{ s3SecretAccessKey: string; passphrase: string }> {
  try {
    const subkeys = await deriveSubkeys(await deriveMasterKey(exportPass, block.kdf));
    return await openJson<{ s3SecretAccessKey: string; passphrase: string }>(
      subkeys.verifyKey,
      b64decode(block.sealed),
    );
  } catch {
    throw new Error("Wrong export passphrase (or the setup file is corrupt).");
  }
}

export function buildSetupDoc(
  settings: SetupSettingsShape,
  secrets: SetupSecretsBlock | null,
): SetupDoc {
  return {
    schema: 1,
    app: "littlewooly-sync",
    exportedAt: new Date().toISOString(),
    vaultName: settings.vaultName,
    s3: {
      endpoint: settings.s3.endpoint,
      region: settings.s3.region,
      accessKeyId: settings.s3.accessKeyId,
      bucket: settings.s3.bucket,
      forcePathStyle: settings.s3.forcePathStyle,
      ...(settings.s3.customHeaders && Object.keys(settings.s3.customHeaders).length
        ? { customHeaders: { ...settings.s3.customHeaders } }
        : {}),
    },
    triggers: {
      syncOnStart: settings.syncOnStart,
      syncOnSave: settings.syncOnSave,
      syncIntervalSec: settings.syncIntervalSec,
    },
    secrets,
  };
}

/** Apply an imported doc onto the live settings object (device name stays device-local). */
export function applySetupDoc(target: SetupSettingsShape, doc: SetupDoc): void {
  target.vaultName = doc.vaultName;
  target.s3.endpoint = doc.s3.endpoint;
  target.s3.region = doc.s3.region;
  target.s3.accessKeyId = doc.s3.accessKeyId;
  target.s3.bucket = doc.s3.bucket;
  target.s3.forcePathStyle = doc.s3.forcePathStyle;
  target.s3.customHeaders = doc.s3.customHeaders ? { ...doc.s3.customHeaders } : undefined;
  target.syncOnStart = doc.triggers.syncOnStart;
  target.syncOnSave = doc.triggers.syncOnSave;
  target.syncIntervalSec = doc.triggers.syncIntervalSec;
}

export function serializeSetupDoc(doc: SetupDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function parseSetupDoc(text: string): SetupDoc {
  let doc: SetupDoc;
  try {
    doc = JSON.parse(text) as SetupDoc;
  } catch {
    throw new Error("The setup file is not valid JSON.");
  }
  if (doc?.app !== "littlewooly-sync" || doc?.schema !== 1 || typeof doc.s3 !== "object") {
    throw new Error("This is not a Little Wooly Sync setup file.");
  }
  return doc;
}
