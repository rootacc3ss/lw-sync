// Small shared modals: a password prompt (used by setup export/import), plus the
// export/import flows over Controller's portability methods.

import { App, Modal, Notice, Setting } from "obsidian";
import type { Controller } from "../controller";
import { SETUP_FILE } from "../portability";

export class PromptModal extends Modal {
  constructor(
    app: App,
    opts: {
      title: string;
      description?: string;
      placeholder?: string;
      buttonText: string;
      /** Return an Error message to keep the modal open; anything else closes it. */
      onSubmit: (value: string) => Promise<Error | string | void>;
    },
  ) {
    super(app);
    this.opts = opts;
  }
  private opts: {
    title: string;
    description?: string;
    placeholder?: string;
    buttonText: string;
    onSubmit: (value: string) => Promise<Error | string | void>;
  };

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });
    if (this.opts.description) {
      contentEl.createEl("p", { text: this.opts.description, cls: "setting-item-description" });
    }
    let value = "";
    new Setting(contentEl).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      if (this.opts.placeholder) t.setPlaceholder(this.opts.placeholder);
      t.onChange((v) => (value = v));
    });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(this.opts.buttonText)
        .setCta()
        .onClick(async () => {
          const err = await this.opts.onSubmit(value);
          if (err instanceof Error) {
            new Notice(`⛔ ${err.message}`);
            return;
          }
          if (typeof err === "string" && err) {
            new Notice(`⛔ ${err}`);
            return;
          }
          this.close();
        }),
    );
  }
}

/** Export with secrets: prompt for a one-time export passphrase, then write the file. */
export function openExportSetupModal(app: App, controller: Controller): void {
  new PromptModal(app, {
    title: "Export setup with secrets",
    description: `The secrets block is encrypted with this one-time passphrase — you'll need it on the new device. Without it the file is useless.`,
    buttonText: "Export",
    onSubmit: async (pass) => {
      if (pass.length < 8) return new Error("Use at least 8 characters for the export passphrase.");
      try {
        await controller.exportSetup(true, pass);
        new Notice(`✅ Wrote ${SETUP_FILE} to the vault root.`);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    },
  }).open();
}

/** Import: prompt for the export passphrase (if the file has secrets), then apply it. */
export function openImportSetupModal(
  app: App,
  controller: Controller,
  onImported: () => void,
): void {
  new PromptModal(app, {
    title: "Import setup",
    description: `Enter the export passphrase if the file includes secrets (leave blank if it doesn't).`,
    placeholder: "export passphrase (optional)",
    buttonText: "Import",
    onSubmit: async (pass) => {
      try {
        const { hadSecrets } = await controller.importSetup(pass);
        new Notice(
          hadSecrets
            ? "✅ Setup imported, including secrets."
            : `✅ Setup imported${pass ? "" : " (no secrets in file — you'll enter them next)"}.`,
        );
        onImported();
      } catch (e) {
        return e as Error;
      }
      return undefined;
    },
  }).open();
}
