// Secret handling. The vault passphrase and the S3 secret access key are NOT stored in
// data.json (which is plaintext and lands in sync backups of `.obsidian/`); they live in
// Obsidian's OS-backed SecretStorage instead (`app.secretStorage`, @since 1.11.4).
//
// Secret IDs must be lowercase alphanumeric with optional dashes.

import type { App } from "obsidian";

const SECRET_PASSPHRASE = "littlewooly-sync-passphrase";
const SECRET_S3 = "littlewooly-sync-s3-secret";

export { SECRET_PASSPHRASE, SECRET_S3 };

/** Read a secret, or "" if unset / storage unavailable. Never throws. */
export function readSecret(app: App, id: string): string {
  try {
    return app.secretStorage?.getSecret(id) ?? "";
  } catch {
    return "";
  }
}

/** Store a secret. Throws only if SecretStorage is unavailable (pre-1.11.4). */
export function writeSecret(app: App, id: string, value: string): void {
  const ss = app.secretStorage;
  if (!ss) throw new Error("Obsidian 1.11.4+ is required to store secrets securely.");
  ss.setSecret(id, value);
}

/** Clear a secret by overwriting with the empty string (the API has no delete). */
export function clearSecret(app: App, id: string): void {
  try {
    app.secretStorage?.setSecret(id, "");
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export function readPassphrase(app: App): string {
  return readSecret(app, SECRET_PASSPHRASE);
}
export function writePassphrase(app: App, value: string): void {
  writeSecret(app, SECRET_PASSPHRASE, value);
}
export function readS3Secret(app: App): string {
  return readSecret(app, SECRET_S3);
}
export function writeS3Secret(app: App, value: string): void {
  writeSecret(app, SECRET_S3, value);
}
