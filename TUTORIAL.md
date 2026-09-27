# Little Wooly Sync — Setup Tutorial

This guide walks you from nothing to a **verified, end-to-end-encrypted backup of your
entire vault**, in three phases: set up your S3 bucket, connect and pick your
preferences, then sync and *prove* the coverage. It takes about ten minutes.

> Already set up? Run **“Little Wooly Sync: Show tutorial”** from the command palette
> for the short orientation.

---

## Phase 1 — Set up your S3 bucket

You need an S3-compatible bucket and an access key before opening the plugin. Pick a
provider below (any other S3-compatible provider works too).

### Cloudflare R2 (recommended)

1. Cloudflare dashboard → **R2 Object Storage** → enable it (10 GB free tier).
2. **Overview → Create bucket** → name it (e.g. `my-obsidian-backup`), pick a location.
3. **Manage R2 API Tokens → Create API Token** → *Object Read & Write* → scope it to
   your bucket. Copy the **Access Key ID** and **Secret Access Key** (the secret is
   shown once!).
4. In the plugin you'll use: endpoint
   `https://<accountid>.r2.cloudflarestorage.com`, region `auto`, **path-style**.

### AWS S3

1. Sign in to the AWS console → **S3 → Create bucket** (region close to you).
2. Block public access: keep it **on** (the plugin authenticates with keys, not URLs).
3. **IAM → Users → Create user** → attach a policy that allows `s3:ListBucket`,
   `s3:GetObject/PutObject/DeleteObject/HeadObject` on your bucket
   (or `AmazonS3FullAccess` if you accept the broader scope for a personal account).
4. **Security credentials → Create access key** → copy the Access Key ID and Secret.
5. In the plugin: endpoint `https://s3.amazonaws.com`, your region,
   **virtual-hosted** addressing.

### Wasabi

1. [wasabi.com](https://wasabi.com) → create account → **Buckets → Create Bucket**.
2. **Account → Access Keys** — the keys created with your account work as-is.
3. In the plugin: endpoint `https://s3.wasabisys.com`, your bucket's region
   (e.g. `us-east-1`), **path-style**.

### Filebase

1. [filebase.com](https://filebase.com) → **Buckets → Create Bucket** → S3 network.
2. **Access Keys → Create** → copy both keys.
3. In the plugin: endpoint `https://s3.filebase.com`, region `us-east-1`, **path-style**.

### iDrive e2

1. [idrive.com/e2](https://www.idrive.com/e2/) → create account → **Create Bucket**.
2. **Access keys → Create** → copy both keys.
3. In the plugin: endpoint `https://<region>.idrivee2.com` (use the region shown in
   your e2 dashboard), region same, **path-style**.

### MinIO (self-hosted)

1. Run `docker run -d -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"`.
2. Open `http://127.0.0.1:9001`, log in with the keys you passed
   (`minioadmin`/`minioadmin` by default), **create a bucket**.
3. In the plugin: endpoint `http://127.0.0.1:9000`, **path-style**.

> **What the provider can see:** your bucket will contain only opaque, encrypted
> objects — not your file contents, not even your file names. Sizes and access times
> are inherent to any storage provider.

---

## Phase 2 — Connect and pick your preferences

1. Open **Settings → Little Wooly Sync** (or click the sheep ribbon) → the setup wizard.
2. Optionally pick a **provider preset** — it autofills endpoint and addressing.
3. Fill in: endpoint, region, **access key ID**, **secret access key**, bucket name.
   The secret is stored in your device's OS-backed secret storage — never in a
   plaintext config file, never uploaded.
4. **Vault name** (default: your vault's name) — one bucket can hold many vaults; each
   lives under `lwsync/<vault name>/`.
5. **Device name** — `desktop`, `laptop`, `pixel`, … — keeps each device's workspace
   config separate. Take two seconds to make these distinct.
6. Hit **Test connection**. You should see ✅ Connected.
   - If you see the ⚠ *conditional create* warning: sync still works fully; the
     warning only means the provider ignores a write-lock the manifest uses as an
     optimization, so it falls back to recompute. No action needed.
7. **Continue** — the plugin checks whether this bucket+vault name already has a vault:

**If it's a NEW vault** — choose the **encryption passphrase**:
- This passphrase encrypts *everything*, on every device, forever. There is no
  recovery, no reset, no backdoor — if you lose it, the backup is ciphertext.
- Use a long, memorable phrase (a few random words). 12+ characters.
- **Write it down somewhere safe** before continuing (password manager is ideal).

**If it's an EXISTING vault** — enter the same passphrase you used originally, then
choose what to restore on this device (**Everything**, or **Content only** if you want
to leave this device's `.obsidian` settings untouched — the safe choice on a fresh
install).

8. **Preferences**:
- *Sync on startup* — sync once when Obsidian opens (recommended).
- *Sync on save* — sync a few seconds after you save a file (recommended).
- *Periodic sync interval* — fallback timer, `300` seconds is a good default; `0`
  disables it.
- *Deleted-file retention* — **Keep everything forever** is the default and the
  recommendation: deleted files go to your local trash, every version stays in the
  bucket, nothing is ever purged. If you opt into a window (14/30/90 days), a file
  deleted on **every** device is eventually removed from the bucket once the window
  passes — live files and their history are never touched.

9. **Start syncing** — the first sync begins.

---

## Phase 3 — Get fully synced, and prove it

1. **Watch the status bar**: 🐑 ready · 🔄 syncing · ✅ done · ⚠️ conflict copies kept ·
   ⛔ error. First sync of a big vault takes a while (every file is encrypted and
   uploaded).
2. When it finishes, run **“Little Wooly Sync: Coverage audit”** (command palette).
   It cross-checks three independent sources — your live vault, the sync manifest, and
   the actual bucket listing — and reports:
   - `FULL COVERAGE VERIFIED: N files backed up, 0 critical findings` ← what you want
   - or a list of problems, each actionable (the **Repair** command fixes most of them)
   - plaintext vs stored size, and **every excluded item with its reason** (by default
     only `.git/`, `node_modules/`, `.trash/` and the plugin's own data dir)
3. Add your **other devices**: install the plugin there, run setup with the same
   bucket + vault name, choose **Connect existing**, same passphrase. That's it —
   edits flow both ways (pull *and* push on every sync).
4. Optional, recommended: **Settings → Little Wooly Sync → Advanced → Create catch-all
   archive** and check **“Write debug report”** occasionally — the report is a
   plain-English summary of your sync health.

### Daily use

- Everything is automatic: startup, saves (debounced), the interval timer, and
  returning to the app on mobile. Manual command: **Sync now**.
- If two devices edit the same file between syncs: `.json` files get a real 3-way
  merge when possible; anything else keeps **both** versions — yours plus a
  `… (conflict copy from <device> <date>)` file. Nothing is silently overwritten.
- Moving devices: **Settings → Advanced → Export setup file** creates
  `littlewooly-sync-setup.json` in your vault root (connection + preferences;
  optionally your secrets, encrypted with a one-time export passphrase). On the new
  device, drop that file into the vault root before running setup — the wizard will
  offer to import it.

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| ⛔ connection failed | Re-check endpoint/region/keys; use **Test connection**; verify the bucket exists |
| ⚠ conditional-create warning | Informational — no action needed |
| ⛔ wrong passphrase | The vault passphrase is the one chosen on the first device, ever |
| Coverage audit shows findings | Run **Repair** (additive — it never deletes), then audit again |
| A file is missing everywhere | Check the local trash, then the conflict copies; every version is still in the bucket's history |
