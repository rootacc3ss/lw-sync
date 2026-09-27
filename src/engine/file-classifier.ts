// The central coverage decision: every vault path -> CONTENT | SHARED_CONFIG |
// DEVICE_CONFIG | EXCLUDE(reason). Nothing is ever dropped silently — exclusions carry a
// reason and surface in the coverage roster. DEVICE_CONFIG is namespaced per device and
// never auto-applied to another device (the fix for the reference's .obsidian thrash).

import type { ClassifyResult, FileTier, VaultConfig } from "../types";

export interface ClassifyOptions {
  deviceConfigGlobs: string[];
  exclusionGlobs: string[];
  overrides: Record<string, FileTier | "EXCLUDE">;
  /** plugin id, so we can hard-exclude our own data dir under .obsidian/plugins/. */
  pluginDir: string;
}

export function makeClassifyOptions(config: VaultConfig, pluginId: string): ClassifyOptions {
  return {
    deviceConfigGlobs: config.deviceConfigGlobs,
    exclusionGlobs: config.exclusionGlobs,
    overrides: config.classificationOverrides,
    pluginDir: `.obsidian/plugins/${pluginId}`,
  };
}

function escapeRe(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob matcher: `**` = any chars, `*` = any non-slash. Full-path match. */
export function matchGlob(path: string, glob: string): boolean {
  // A "dir/**" glob also matches the bare directory.
  if (glob.endsWith("/**") && path === glob.slice(0, -3)) return true;

  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**", i)) {
      re += ".*";
      i++; // consume the second '*'
    } else if (glob[i] === "*") {
      re += "[^/]*";
    } else {
      re += escapeRe(glob[i]);
    }
  }
  re += "$";
  return new RegExp(re).test(path);
}

export function classify(path: string, opts: ClassifyOptions): ClassifyResult {
  // 1. Explicit user overrides win.
  const override = opts.overrides[path];
  if (override === "EXCLUDE") return { tier: "EXCLUDE", reason: "user override" };
  if (override) return { tier: override };

  // 2. Our own plugin dir — excluded to avoid a sync feedback loop.
  if (path === opts.pluginDir || path.startsWith(opts.pluginDir + "/")) {
    return { tier: "EXCLUDE", reason: "Little Wooly Sync data dir (feedback loop)" };
  }

  // 3. Default noise exclusions (shown in the roster, never silent).
  for (const g of opts.exclusionGlobs) {
    if (matchGlob(path, g)) return { tier: "EXCLUDE", reason: `excluded by rule: ${g}` };
  }

  // 4. Device-specific config — backed up per device, never shared.
  for (const g of opts.deviceConfigGlobs) {
    if (matchGlob(path, g)) return { tier: "DEVICE_CONFIG" };
  }

  // 5. Portable Obsidian config.
  if (path === ".obsidian" || path.startsWith(".obsidian/")) return { tier: "SHARED_CONFIG" };

  // 6. Everything else is user content (any extension, hidden or not).
  return { tier: "CONTENT" };
}
