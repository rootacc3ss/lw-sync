// The post-setup "You're all set" content — shared by the setup wizard's final screen
// and the "Show tutorial" command. A quick orientation, not a manual: the full walkthrough
// is TUTORIAL.md in the repository.

import { App, Modal, Setting } from "obsidian";

export function renderTutorialContent(el: HTMLElement): void {
  el.createEl("h2", { text: "You're all set 🐑" });
  el.createEl("p", {
    text: "Your vault is being backed up, end-to-end encrypted, to your own bucket.",
    cls: "setting-item-description",
  });

  const steps = el.createEl("ol");
  const li = (title: string, body: string) => {
    const item = steps.createEl("li");
    item.createEl("strong", { text: title });
    item.createEl("span", { text: ` — ${body}` });
  };
  li(
    "Watch the status bar",
    "🐑 idle, 🔄 syncing, ✅ done, ⚠️ conflict copies kept, ⛔ error. Hover/tap commands: “Sync now”, “Coverage audit”, “Repair”.",
  );
  li(
    "Prove your coverage",
    "Run “Coverage audit” once your first sync finishes. It cross-checks every file, the manifest, and the bucket — and reports anything excluded, with the reason.",
  );
  li(
    "Add your other devices",
    "Install the plugin there, run setup with the same bucket + vault name, choose “Connect existing”, and use the same passphrase.",
  );
  li(
    "Nothing is really deleted",
    "Deletes go to your local trash, the history keeps every version in the bucket, and by default nothing is ever purged. (Optional retention is in Settings.)",
  );

  el.createEl("p", {
    text: "Full walkthrough (providers, keys, verification): TUTORIAL.md in the repository.",
    cls: "setting-item-description",
  });
}

export class TutorialModal extends Modal {
  onOpen(): void {
    this.contentEl.empty();
    renderTutorialContent(this.contentEl);
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Done")
        .setCta()
        .onClick(() => this.close()),
    );
  }
}

export function showTutorial(app: App): void {
  new TutorialModal(app).open();
}
