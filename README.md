# Little Wooly Sync

Real-time, end-to-end encrypted backup of **every** file in your Obsidian vault to any
S3-compatible bucket — with coverage you can actually verify.

Part of the **Little Wooly** suite, a privacy-centric alternative to Notion and typical
cloud storage.

> **Status: beta.** It works and it is tested, but it has not been run against a wide range
> of vaults and providers yet. Keep an independent backup until you have verified a restore
> yourself.

## Why

Sync plugins tend to lose files quietly. They ship default exclusions, opt-in hidden-file
sync, and size caps you never asked for — so an 800 MB vault becomes a 300 MB backup and
nothing tells you. This plugin exists to not do that.

1. **Strong client-side encryption.** The bucket never sees plaintext — not your file
   contents, not even your file names.
2. **Total, verifiable coverage.** Every file, folder, hidden item, any extension, any
   size. Nothing is skipped silently, and the coverage audit can prove it.
3. **Reliable multi-device sync**, with conflicts preserved rather than resolved away.
4. **A focused UI.** One setup screen, and a settings page you can read in one sitting.

## Install

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. BRAT → *Add beta plugin* → `rootacc3ss/littlewooly-sync`
3. Enable **Little Wooly Sync** in Community Plugins.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/rootacc3ss/littlewooly-sync/releases) into
`<vault>/.obsidian/plugins/littlewooly-sync/`, then enable the plugin.

Desktop **and mobile** (iOS/Android) — the plugin talks to your bucket through Obsidian's
`requestUrl` (no CORS restrictions on either platform) and enumerates the vault through the
vault adapter, so it reads every file — hidden files included — with no Node APIs.

## Setup

**New here? Follow the [step-by-step tutorial](TUTORIAL.md)** — pick a provider, create a
bucket, get keys, connect, verify. Otherwise, the short version — enabling the plugin
opens a guided wizard:

| Field | Notes |
| --- | --- |
| **Endpoint** | Your provider's S3 endpoint |
| **Region** | e.g. `us-east-1`, or `auto` for Cloudflare R2 |
| **Access key ID** / **Secret access key** | Stored in Obsidian's OS-backed secret storage (not in plaintext `data.json`), never uploaded |
| **Bucket** | Must already exist |
| **Addressing** | Path-style (`host/bucket/…`) or virtual-hosted (`bucket.host/…`) |
| **Vault name** | Data lives under `lwsync/<vault name>/`, so one bucket can hold many vaults |
| **Device name** | `desktop`, `laptop`, … — keeps per-device config separate |

Presets autofill endpoint and addressing for **AWS S3, Cloudflare R2, Wasabi, Filebase,
iDrive e2**, and local MinIO. Any other S3-compatible provider works — just enter the
endpoint yourself. Hit **Test connection** before continuing.

The wizard then branches on what it finds in the bucket:

- **Nothing there yet** → choose an encryption passphrase, and the first backup begins.
- **An existing vault** → enter that vault's passphrase, then pick how to restore:
  - **Everything** — your notes plus shared config.
  - **Content only** — just your files; this device's `.obsidian` is left untouched.
    Safest on a fresh install.

Use the **same passphrase and vault name** on every device, and a **different device name**
on each.

> Your passphrase is the encryption key. It is never sent anywhere, and **there is no
> recovery if you lose it.**

## Commands

| Command | What it does |
| --- | --- |
| **Set up / connect** | Reopen the wizard |
| **Sync now** | Pull, merge, then push |
| **Coverage audit** | Three-way diff of vault vs. manifest vs. bucket, plus size reconciliation |
| **Repair** | Additively fix what the audit found — re-upload missing objects, rebuild the index |
| **Show tutorial** | Short orientation: status bar, commands, next steps |
| **Write debug report** | Dump diagnostic state to a file in your vault |

Sync on startup, debounced sync on save, and a periodic interval are all toggleable in
settings (and offered during setup). You can also back up or restore this device's config
on demand, or build a catch-all archive of hidden and config files.

**Run the coverage audit after your first full sync.** If a file did not make it, the audit
names it — you should never have to guess whether your backup is complete.

## Moving devices

**Settings → Advanced → Export setup file** writes `littlewooly-sync-setup.json` to your
vault root: connection, addressing, custom headers, and preferences. Optionally include
your secrets — they're sealed with a one-time export passphrase (Argon2id + AES-GCM) and
never appear in the file in plaintext. On the new device, drop the file into the vault
root before running setup; the wizard offers to import it. The file syncs with your vault
(encrypted like everything else) — delete it after migrating if you prefer.

## Deleted files & retention

**Default: nothing is ever really deleted.** Deleting a file moves it to your local trash,
records a tombstone, and keeps every version in the bucket — restorable forever. If you
want bounded storage, Settings (and setup) offer an optional purge window (14/30/90 days):
once **every** device has recorded a deletion and the window has passed, that file's
encrypted objects are removed from the bucket. Live files and their version history are
never touched; purged means unrecoverable.

## How it works

- **Encryption.** Argon2id derives a master key from your passphrase; HKDF splits it into
  subkeys. Files are encrypted with AES-256-GCM using a deterministic nonce, and object
  names are secret-keyed HMACs. This is convergent encryption: identical plaintext produces
  identical ciphertext, so uploads dedupe and retries are idempotent, while the bucket still
  learns nothing. Primitives are native WebCrypto plus `hash-wasm` — nothing hand-rolled.
- **Objects are immutable and content-addressed.** Editing a file writes a new object; the
  old one stays, for history and restore. Large files are chunked, never skipped.
- **The manifest** is a set of per-device append-only logs. A merged global manifest is
  advanced by S3 conditional PUT. If your provider ignores conditional PUT, the merged
  manifest is fully rebuildable from the device logs — a lost race costs a recompute, never
  data.
- **Device config is namespaced per device** and never auto-applied elsewhere, so syncing
  cannot break another machine's Obsidian setup.
- **Deletes are conservative.** A file must be absent from both independent walkers across
  two separate scans before it is tombstoned, and deletions go to Obsidian's trash — you
  decide when they are really gone (and by default, nothing is ever purged — see
  [Deleted files & retention](#deleted-files--retention)).
- **Conflicts are never silently dropped.** You get a conflict copy, with 3-way merge for
  JSON.

## Roadmap (v2)

- **Version-history browser & one-click restore** — every version already sits in the
  bucket (objects are immutable); this is a UI over data that's already there.
- **Multi-user vaults** — share an encrypted vault with other people (per-user keys).
- **Live sync / background push** — near-real-time propagation between devices.

## Development

```bash
npm install
npm run dev        # esbuild watch -> main.js
npm run build      # typecheck + production bundle
npm run gates      # typecheck + lint + format check + unit tests
```

Integration tests run against a local MinIO:

```bash
npm run test:minio:up
npm run test:integration
npm run test:minio:down
```

## Credits

Inspired by [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) by vorotamoroz
(MIT) — an excellent plugin whose crypto and S3 work shaped the thinking here. No code is
shared between the two projects.

## License

MIT
