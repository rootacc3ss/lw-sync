import { describe, test, expect } from "vitest";
import { classify, makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";

const opts = makeClassifyOptions(defaultVaultConfig("v", "desktop"), "littlewooly-sync");

describe("classify", () => {
  test("user notes & attachments are CONTENT (any extension)", () => {
    expect(classify("Daily/2026-06-15.md", opts)).toEqual({ tier: "CONTENT" });
    expect(classify("attachments/photo.heic", opts)).toEqual({ tier: "CONTENT" });
    expect(classify("data/raw.weirdext", opts)).toEqual({ tier: "CONTENT" });
  });

  test("portable .obsidian config is SHARED_CONFIG", () => {
    expect(classify(".obsidian/community-plugins.json", opts)).toEqual({ tier: "SHARED_CONFIG" });
    expect(classify(".obsidian/snippets/custom.css", opts)).toEqual({ tier: "SHARED_CONFIG" });
  });

  test("device-specific config is DEVICE_CONFIG (never auto-applied across devices)", () => {
    expect(classify(".obsidian/workspace.json", opts)).toEqual({ tier: "DEVICE_CONFIG" });
    expect(classify(".obsidian/appearance.json", opts)).toEqual({ tier: "DEVICE_CONFIG" });
  });

  test("the plugin's own dir is excluded (feedback loop)", () => {
    const r = classify(".obsidian/plugins/littlewooly-sync/data.json", opts);
    expect(r.tier).toBe("EXCLUDE");
  });

  test("default noise is excluded with a reason, not silently", () => {
    for (const p of [".git/config", "node_modules/x/index.js", ".trash/old.md"]) {
      const r = classify(p, opts);
      expect(r.tier).toBe("EXCLUDE");
      if (r.tier === "EXCLUDE") expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test("a directory form of an exclusion glob is also excluded", () => {
    expect(classify(".git", opts).tier).toBe("EXCLUDE");
  });

  test("user overrides win over defaults", () => {
    const cfg = defaultVaultConfig("v", "desktop");
    cfg.classificationOverrides["Secret/private.md"] = "EXCLUDE";
    cfg.classificationOverrides[".obsidian/workspace.json"] = "SHARED_CONFIG";
    const o = makeClassifyOptions(cfg, "littlewooly-sync");
    expect(classify("Secret/private.md", o).tier).toBe("EXCLUDE");
    expect(classify(".obsidian/workspace.json", o)).toEqual({ tier: "SHARED_CONFIG" });
  });
});
