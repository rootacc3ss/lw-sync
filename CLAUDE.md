# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Little Wooly Sync** — an Obsidian plugin (desktop **and** mobile) that backs up, in real
time, **ALL** files in a vault to any S3-compatible bucket, **end-to-end encrypted**, with
**provable coverage** and **no silent caps**. Part of the Little Wooly suite.

North star, in priority order:
1. **Strong client-side E2E encryption** — the bucket never sees plaintext (content or names).
2. **Total, verifiable coverage** — every file/folder/hidden item, any extension, any size.
   Nothing is ever skipped silently. The coverage-audit command must be able to *prove* it.
3. **Reliable multi-device sync** with safe conflict handling (nothing silently lost).
4. **A focused, simple UX** — deliberately the opposite of the over-complicated reference.

The full design lives in `~/.claude/plans/quizzical-twirling-squirrel.md` (the approved plan).

## Hard rules

- **Never commit secrets.** `.env`, `.test.env`, vault data, keys, and `main.js` are gitignored.
  History will be purged before public release, but do not rely on that — keep secrets out.
- **`archive/examples/obsidian-livesync/` is read-only reference.** It is **local-only and
  gitignored** — present on disk, never committed. Study it; never import or extend it. It is a working plugin with great crypto/S3 ideas but the two flaws we exist to
  fix: it silently drops files (opt-in hidden sync, size caps, default exclusions) and it is
  over-complicated (~230 settings, CouchDB/P2P/CLI). We are the lean, total-coverage answer.
- **No silent limits.** Large files are chunked, never skipped. We impose no file/bucket cap.
- **Crypto:** native WebCrypto + `hash-wasm` (Argon2id) only. Never hand-roll primitives.

## Commands

- `npm run dev` — esbuild watch build (writes `main.js`).
- `npm run build` — typecheck + production bundle.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` / `npm run format` / `npm run format:check`.
- `npm run test` / `npm run test:unit` / `npm run test:integration` — vitest.
- `npm run test:minio:up` / `:down` — local MinIO container for S3 integration tests (uses
  docker when available, otherwise podman).
- `npm run gates` — typecheck + lint + format:check + unit tests + production build +
  bundle guard (run before declaring done).
- `npm run verify:bundle` — fails if `main.js` contains Node-only constructs (would break
  mobile). Guard: keep esbuild on `platform: "browser"`; no Node built-ins, ever.
- A single test: `npx vitest run test/unit/object-cipher.test.ts` (or `-t "<name>"`).

## Architecture

Bundled by esbuild to a single CJS `main.js` with `platform: "browser"` — no Node built-ins
anywhere, so the same bundle runs on desktop (Electron) and mobile (Capacitor/WKWebView).
`minAppVersion` is 1.11.4 (required for `app.secretStorage`).

- `src/crypto/` — `keys.ts` (Argon2id KDF, RFC 9106 64 MiB mobile-safe default → HKDF
  subkeys → verifier), `object-cipher.ts` (convergent AES-256-GCM: deterministic nonce +
  secret-keyed HMAC names → dedup + idempotency), `box.ts` (random-nonce AES-GCM for
  manifests/config), `bytes.ts` (pure-TS base64 — no Buffer).
- `src/store/` — `backend.ts` (ObjectBackend interface + PreconditionFailedError),
  `obs-http-handler.ts` (smithy HttpHandler over Obsidian `requestUrl` — the single HTTP
  path that bypasses CORS on BOTH desktop and mobile), `s3-client.ts` (SDK wrapper:
  path/virtual style, custom headers, conditional PUT, checksums pinned WHEN_REQUIRED,
  `testConnection` → `{ conditionalPut }`), `prefixed-backend.ts` (`lwsync/<vault>/`
  scoping), `object-store.ts` (chunking, content-addressed dedup, idempotent PUT, recipe
  objects), `manifest-store.ts` (per-device append-only logs + CAS-merged global manifest,
  tombstones), `vault-config.ts` (encrypted `meta/vaultconfig` for cross-device bootstrap;
  no secrets), `device-config-store.ts` (per-device `.obsidian` backup/restore).
- `src/engine/` — `file-classifier.ts` (**central**: CONTENT / SHARED_CONFIG / DEVICE_CONFIG /
  EXCLUDE — device-specific config is namespaced per device and never auto-applied elsewhere),
  `vault-walker.ts` (adapter `list`/`stat` enumeration — no Node fs; returns entries + a
  roster of every exclusion with its reason), `obsidian-vault-fs.ts` (DataAdapter-backed
  VaultFS with an onWrite self-write hook), `local-index.ts` + `idb-index.ts` (IndexedDB
  cache, rebuildable), `sync-engine.ts` (pull-merge before push; JSON 3-way merge attempt
  before conflict copy), `conflict-resolver.ts` (conflict-copy + JSON 3-way merge), `trash.ts`
  (soft-delete via adapter trash), `coverage-auditor.ts` + `coverage-service.ts` (three-way
  live/manifest/bucket diff, chunk verification, orphan detection, size reconciliation),
  `repair.ts` (additive fix), `archive-job.ts` (LWA1 catch-all archive; optional gzip via
  CompressionStream — no tar, no Node), `retention.ts` (pure purge collector + safe purge;
  default 0 = nothing is ever deleted, any live head on any device vetoes a purge, shared
  dedup chunks are protected, an unreadable protected recipe vetoes the whole purge).
- `src/portability.ts` — setup export/import (`littlewooly-sync-setup.json` in the vault
  root; secrets only opt-in, sealed with a one-time export passphrase via the same
  Argon2id→HKDF→AES-GCM stack; never plaintext).
- `src/ui/` — `setup-wizard.ts` (connection → passphrase/restore → **Preferences** →
  "You're all set"; custom headers; import from a setup file), `settings-tab.ts` (slim,
  progressive; conditional-PUT warning; custom headers; retention; export/import),
  `status-bar.ts`, `custom-headers.ts` (`Header: value` serialization), `modals.ts`
  (password prompt + export/import flows), `tutorial.ts` (shared orientation content +
  Show tutorial command).
- `src/controller.ts` — stack wiring, `testConnection` → `{ conditionalPut }`, mobile KDF
  memory warning, self-write tracking. `src/secrets.ts` — passphrase + S3 secret live in
  Obsidian SecretStorage (`app.secretStorage`), NEVER in plaintext `data.json`; `main.ts`
  migrates legacy plaintext secrets on load.
- `src/main.ts` — entry/wiring; triggers: sync-on-start, interval, sync-on-save (debounced,
  ignores self-writes), `visibilitychange` resume (mobile suspend-safe). `src/types.ts` —
  shared, dependency-free types.

### Key invariants
- **Manifest source of truth = per-device append-only logs**; the merged manifest is derived
  and advanced by S3 conditional PUT (CAS). If a backend ignores conditional PUT, the merged
  manifest is fully rebuildable from device logs — a lost race costs a recompute, never data.
- **Objects are immutable & content-addressed**; a change makes a new object, old versions stay
  (history/restore). Convergent encryption makes identical plaintext dedupe to one object.
- **Coverage is proven, not assumed**: every walked item is recorded with INCLUDE/EXCLUDE(reason);
  deletions need absence in *both* walkers across *two* scans before tombstoning.
- **Nothing is deleted by default** (`VaultConfig.retentionDays = 0`): retention purge only runs
  when opted in, only touches paths tombstoned on EVERY device manifest past the window, never
  live files or their old versions, and shared dedup chunks are never deleted.

## Testing layout
- `test/unit/` — pure-logic tests (crypto, classifier, manifest fold, audit diff, LWA1
  archive round-trip, retention collector/purge, setup-portability round-trips,
  ObsHttpHandler with an injected fake `requestUrl`).
- `test/integration/` — against local MinIO (`test:minio:up` first; defaults work with
  `minioadmin`, or override via `.test.env`-style `LWS_S3_*` env vars).
- `test/shell/` — MinIO start/stop scripts (docker or podman; podman-compatible).
- `test/helpers/obsidian-mock.ts` — vitest aliases `obsidian` here (the real package ships
  types only). `test/helpers/memory-vault-fs.ts` — in-memory VaultFS; pass ONE shared clock
  into every device so manifest-fold LWW sees comparable mtimes.
