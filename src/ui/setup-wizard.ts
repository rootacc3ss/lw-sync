// First-run / connect flow: one screen of connection fields (+ Test, + import from a
// setup file), then the PASSPHRASE finds the vault — vault location is a random opaque
// id, never the vault name, so discovery works by trying to open each vault with the
// passphrase. None opens? Create one. Several? Pick. Both paths end at Preferences,
// then a short "You're all set" orientation. Custom-only by design: any S3-compatible
// provider works; a successful connection test is required before advancing, and again
// before finishing.

import { App, Modal, Notice, Platform, Setting } from "obsidian";
import type { Controller, LwsSettings } from "../controller";
import type { LocatedVault } from "../store/vault-locator";
import { readS3Secret, writeS3Secret } from "../secrets";
import { SETUP_FILE } from "../portability";
import { formatHeaderLines, parseHeaderLines } from "./custom-headers";
import { openImportSetupModal } from "./modals";
import { renderTutorialContent } from "./tutorial";

export class SetupWizard extends Modal {
  /** Renders started while an earlier one are aborted at their next await point. */
  private renderSeq = 0;
  private testStatusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private controller: Controller,
    private settings: LwsSettings,
    private onDone: () => Promise<void>,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const seq = ++this.renderSeq;
    const { contentEl, settings } = { contentEl: this.contentEl, settings: this.settings };
    contentEl.empty();
    contentEl.createEl("h2", { text: "Little Wooly Sync — setup" });
    contentEl.createEl("p", {
      text: "Back up ALL of your vault to any S3-compatible bucket, end-to-end encrypted.",
    });
    if (Platform.isMobileApp) {
      contentEl.createEl("p", {
        text: "On mobile, sync runs when the app is open and resumes on return to foreground. Large vaults may take a while and use more memory.",
        cls: "setting-item-description",
      });
    }

    // Moving devices? If a setup file sits in the vault root, offer to load it.
    if (await this.app.vault.adapter.exists(SETUP_FILE)) {
      if (seq !== this.renderSeq) return; // superseded by a newer render
      new Setting(contentEl)
        .setName("Import setup from file")
        .setDesc(`Found ${SETUP_FILE} in the vault root — loads connection + preferences.`)
        .addButton((b) =>
          b
            .setButtonText("Import")
            .setCta()
            .onClick(() =>
              openImportSetupModal(this.app, this.controller, () => void this.onOpen()),
            ),
        );
    }

    const text = (name: string, get: () => string, set: (v: string) => void, ph = "") =>
      new Setting(contentEl).setName(name).addText((t) => {
        t.setPlaceholder(ph).setValue(get());
        t.onChange(set);
      });

    text(
      "Endpoint",
      () => settings.s3.endpoint,
      (v) => (settings.s3.endpoint = v),
      "https://s3.amazonaws.com",
    ).setDesc("Your provider's S3 endpoint, including the scheme (https:// or http://).");
    text(
      "Region",
      () => settings.s3.region,
      (v) => (settings.s3.region = v),
      "us-east-1",
    ).setDesc(
      "AWS/Wasabi need the exact region; Cloudflare R2 uses auto; most others accept anything.",
    );
    text(
      "Access key ID",
      () => settings.s3.accessKeyId,
      (v) => (settings.s3.accessKeyId = v),
    );
    new Setting(contentEl).setName("Secret access key").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(readS3Secret(this.app)).onChange((v) => writeS3Secret(this.app, v));
    });
    text(
      "Bucket",
      () => settings.s3.bucket,
      (v) => (settings.s3.bucket = v),
    ).setDesc("Every vault in this bucket lives under its own opaque id — names never appear.");
    new Setting(contentEl)
      .setName("Addressing")
      .setDesc("Path-style works with most S3-compatible providers; virtual-hosted for AWS.")
      .addDropdown((d) => {
        d.addOption("path", "Path-style (host/bucket/…)");
        d.addOption("virtual", "Virtual-hosted (bucket.host/…)");
        d.setValue(settings.s3.forcePathStyle ? "path" : "virtual");
        d.onChange((v) => (settings.s3.forcePathStyle = v === "path"));
      });
    text(
      "Device name",
      () => settings.deviceName,
      (v) => (settings.deviceName = v),
      "desktop / mobile / …",
    ).setDesc("This device's name (kept out of the bucket — it lives encrypted).");

    new Setting(contentEl)
      .setName("Custom request headers")
      .setDesc("Optional. One per line as `Header: value` — for auth proxies/gateways.")
      .addTextArea((t) => {
        t.setValue(formatHeaderLines(settings.s3.customHeaders)).onChange((v) => {
          settings.s3.customHeaders = parseHeaderLines(v);
        });
        t.inputEl.rows = 2;
      });

    this.testStatusEl = contentEl.createEl("p", {
      text: "Connection not tested yet — a successful test is required to continue.",
      cls: "setting-item-description",
    });

    const runTest = async (): Promise<boolean> => {
      const err = this.normalizeInputs();
      if (err) {
        this.setTestStatus(`⛔ ${err}`, false);
        return false;
      }
      try {
        await this.controller.testConnection();
        this.setTestStatus("✅ Connected & authenticated.", true);
        return true;
      } catch (e) {
        this.setTestStatus(`⛔ ${(e as Error).message}`, false);
        return false;
      }
    };

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Test connection").onClick(async () => void (await runTest())),
    );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Test & continue")
        .setCta()
        .onClick(async () => {
          if (!(await runTest())) return;
          this.renderPassphrase();
        }),
    );
  }

  private setTestStatus(text: string, ok: boolean): void {
    this.testStatusEl?.setText(text);
    if (this.testStatusEl)
      this.testStatusEl.style.color = ok ? "var(--text-success)" : "var(--text-error)";
  }

  /**
   * Trim + normalize everything the user typed, in place. Returns an error string, or
   * null when the inputs are well-formed enough to attempt a connection.
   */
  private normalizeInputs(): string | null {
    const s = this.settings;
    s.s3.endpoint = s.s3.endpoint.trim().replace(/\/+$/, "");
    s.s3.region = s.s3.region.trim();
    s.s3.accessKeyId = s.s3.accessKeyId.trim();
    s.s3.bucket = s.s3.bucket.trim();
    s.deviceName = s.deviceName.trim();
    const secret = readS3Secret(this.app).trim();
    if (secret) writeS3Secret(this.app, secret);

    if (!/^https?:\/\//i.test(s.s3.endpoint))
      return "Endpoint must start with http:// or https:// (e.g. https://s3.amazonaws.com).";
    if (!s.s3.bucket) return "Bucket is required.";
    if (!s.deviceName) return "Device name is required.";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s.s3.bucket))
      new Notice(
        "⚠ That bucket name looks unusual for S3 (lowercase letters, numbers, dots, dashes; 3–63 chars). Testing anyway.",
        8000,
      );
    return null;
  }

  /**
   * The passphrase screen: the passphrase LOCATES the vault (each vault in the bucket
   * is tried; the one that opens with this passphrase is yours). None opens -> create.
   */
  private renderPassphrase(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Open your vault" });
    contentEl.createEl("p", {
      text: "Enter your encryption passphrase. We'll find the vault in this bucket that opens with it — none does? You'll be able to create one.",
      cls: "setting-item-description",
    });
    let pass = "";
    new Setting(contentEl).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (pass = v));
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Find my vault")
        .setCta()
        .onClick(async () => {
          if (!pass) {
            new Notice("⛔ Enter the passphrase.");
            return;
          }
          let found: LocatedVault[];
          try {
            found = await this.controller.discoverVaults(pass);
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
            return;
          }
          if (found.length === 0) {
            this.renderNewVault(pass);
            return;
          }
          if (found.length === 1) {
            try {
              if (!(await this.controller.connectLocated(found[0], pass))) {
                new Notice("⛔ Wrong passphrase.");
                return;
              }
            } catch (e) {
              new Notice(`⛔ ${(e as Error).message}`);
              return;
            }
            this.renderRestoreChoice();
            return;
          }
          this.renderVaultPicker(found, pass);
        }),
    );
  }

  /** Several vaults share this passphrase — pick which to open. */
  private renderVaultPicker(candidates: LocatedVault[], pass: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Multiple vaults match" });
    contentEl.createEl("p", {
      text: "More than one vault in this bucket opens with that passphrase. Which is yours?",
      cls: "setting-item-description",
    });
    for (const c of candidates) {
      new Setting(contentEl)
        .setName(c.vaultName || `vault ${c.vaultId.slice(0, 8)}…`)
        .addButton((b) =>
          b
            .setButtonText("Connect")
            .setCta()
            .onClick(async () => {
              try {
                if (!(await this.controller.connectLocated(c, pass))) {
                  new Notice("⛔ Wrong passphrase.");
                  return;
                }
                this.renderRestoreChoice();
              } catch (e) {
                new Notice(`⛔ ${(e as Error).message}`);
              }
            }),
        );
    }
  }

  /** No vault opened with that passphrase — create a new one with it. */
  private renderNewVault(pass: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "New vault — confirm your passphrase" });
    contentEl.createEl("p", {
      text: `No vault in this bucket opens with that passphrase. Create a new encrypted vault with it? It will be labeled "${this.app.vault.getName()}" (a label only — never stored in a bucket key).`,
      cls: "setting-item-description",
    });
    let confirm = "";
    new Setting(contentEl).setName("Confirm passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (confirm = v));
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Create vault")
        .setCta()
        .onClick(async () => {
          if (pass.length < 8) {
            new Notice("⛔ Use at least 8 characters.");
            return;
          }
          if (pass !== confirm) {
            new Notice("⛔ Passphrases do not match.");
            return;
          }
          try {
            await this.controller.initNewVault(pass);
            this.renderPreferences();
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
          }
        }),
    );
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Back — try another passphrase").onClick(() => this.renderPassphrase()),
    );
  }

  private renderRestoreChoice(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connected ✅ — how should we restore on this device?" });
    new Setting(contentEl)
      .setName("Everything")
      .setDesc(
        "Your notes + shared config. (Restore this device's saved layout separately from Settings.)",
      )
      .addButton((b) =>
        b
          .setButtonText("Restore everything")
          .setCta()
          .onClick(() => this.renderPreferences()),
      );
    new Setting(contentEl)
      .setName("Content only")
      .setDesc(
        "Just your files — leave this device's Obsidian config (.obsidian) untouched. Safest on a fresh install.",
      )
      .addButton((b) => b.setButtonText("Content only").onClick(() => this.renderPreferences()));
  }

  /** Preferences screen: triggers + deletion retention (the "pick your preferences" step). */
  private renderPreferences(): void {
    const { contentEl, settings } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Preferences" });
    contentEl.createEl("p", {
      text: "How this device syncs. You can change all of this anytime in Settings.",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Sync on startup")
      .addToggle((t) =>
        t.setValue(settings.syncOnStart).onChange((v) => (settings.syncOnStart = v)),
      );
    new Setting(contentEl)
      .setName("Sync on save (debounced)")
      .setDesc("Sync shortly after files change. Works in every auto-sync mode.")
      .addToggle((t) => t.setValue(settings.syncOnSave).onChange((v) => (settings.syncOnSave = v)));
    new Setting(contentEl)
      .setName("Auto-sync")
      .setDesc(
        "How this device keeps itself updated in the background. Periodic is the stable, lowest-load option (fewest S3 calls); Live keeps you persistently updated by syncing a few seconds after you stop typing.",
      )
      .addDropdown((d) => {
        d.addOption("off", "Off — manual sync only");
        d.addOption("periodic", "Periodic — every N seconds (stable, lowest load)");
        d.addOption("live", "Live — sync a few seconds after you stop typing");
        d.setValue(settings.autoSyncMode);
        d.onChange((v) => (settings.autoSyncMode = v as typeof settings.autoSyncMode));
      });
    new Setting(contentEl)
      .setName("Periodic interval (seconds)")
      .setDesc("Used when Auto-sync is Periodic.")
      .addText((t) =>
        t.setValue(String(settings.autoSyncIntervalSec)).onChange((v) => {
          settings.autoSyncIntervalSec = Math.max(15, parseInt(v || "0", 10) || 300);
        }),
      );
    new Setting(contentEl)
      .setName("Live idle delay (seconds)")
      .setDesc("Used when Auto-sync is Live: seconds of quiet after changes before syncing.")
      .addText((t) =>
        t.setValue(String(settings.liveIdleSec)).onChange((v) => {
          settings.liveIdleSec = Math.min(300, Math.max(2, parseInt(v || "0", 10) || 5));
        }),
      );

    const days = this.controller.ready ? this.controller.retentionDays : 0;
    let retention = days;
    new Setting(contentEl)
      .setName("Deleted-file retention")
      .setDesc(
        "Default: keep everything forever — nothing is ever purged and deleted files stay restorable. Choosing a window removes a deleted file's encrypted objects from the bucket once every device has recorded the deletion and the window has passed. Live files and their version history are never touched. Purged means unrecoverable.",
      )
      .addDropdown((d) => {
        d.addOption("0", "Keep everything forever (recommended)");
        d.addOption("14", "14 days");
        d.addOption("30", "30 days");
        d.addOption("90", "90 days");
        d.setValue(String(days));
        d.onChange((v) => (retention = parseInt(v, 10) || 0));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Continue")
        .setCta()
        .onClick(async () => {
          try {
            if (this.controller.ready && retention !== this.controller.retentionDays) {
              await this.controller.setRetention(retention);
            }
            this.renderDone();
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
          }
        }),
    );
  }

  /** Final screen: short orientation (shared with the "Show tutorial" command). */
  private renderDone(): void {
    const { contentEl } = this;
    contentEl.empty();
    renderTutorialContent(contentEl);
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Start syncing")
        .setCta()
        .onClick(() => void this.finish("Setup complete — first sync starting…")),
    );
  }

  /**
   * Final gate: re-verify the connection before declaring the plugin configured, so
   * "done" can never be reached with a broken config. `configured` is only set (and
   * persisted via onDone) here — backing out earlier leaves a consistent "not
   * configured" state that re-running setup handles cleanly.
   */
  private async finish(msg: string): Promise<void> {
    try {
      await this.controller.testConnection();
    } catch (e) {
      new Notice(
        `⛔ Connection failed: ${(e as Error).message} — check Settings → connection, or re-run setup.`,
        10000,
      );
      return;
    }
    this.settings.configured = true;
    new Notice(msg);
    this.close();
    await this.onDone();
  }
}
