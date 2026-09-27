import { describe, test, expect } from "vitest";
import { walkVault, type WalkAdapter } from "../../src/engine/vault-walker";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";

/** In-memory WalkAdapter over a flat map of path -> content. */
class MockAdapter implements WalkAdapter {
  constructor(private files: Map<string, string>) {}

  private children(dir: string, wantFiles: boolean): string[] {
    const prefix = dir ? dir + "/" : "";
    const out = new Set<string>();
    for (const p of this.files.keys()) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        if (wantFiles) out.add(p);
      } else if (!wantFiles) {
        out.add(prefix + rest.slice(0, slash));
      }
    }
    return [...out];
  }

  async list(dir: string) {
    return { files: this.children(dir, true), folders: this.children(dir, false) };
  }

  async stat(path: string) {
    const data = this.files.get(path);
    if (data === undefined) return null;
    return { mtime: 1000, size: data.length, type: "file" };
  }
}

function adapterWith(paths: string[]): MockAdapter {
  return new MockAdapter(new Map(paths.map((p) => [p, "x"])));
}

const opts = makeClassifyOptions(defaultVaultConfig("v", "desktop"), "littlewooly-sync");

describe("walkVault (adapter-based)", () => {
  test("covers content, shared config, and device config; excludes noise with reasons", async () => {
    const adapter = adapterWith([
      "Notes/a.md",
      "attach/pic.png",
      ".obsidian/community-plugins.json",
      ".obsidian/workspace.json",
      ".git/config",
      "node_modules/dep/index.js",
      ".obsidian/plugins/littlewooly-sync/data.json",
    ]);

    const { entries, roster } = await walkVault(adapter, opts);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.tier]));

    expect(byPath["Notes/a.md"]).toBe("CONTENT");
    expect(byPath["attach/pic.png"]).toBe("CONTENT");
    expect(byPath[".obsidian/community-plugins.json"]).toBe("SHARED_CONFIG");
    expect(byPath[".obsidian/workspace.json"]).toBe("DEVICE_CONFIG");

    // excluded items appear in the roster (never silently dropped) and not in entries.
    expect(byPath[".git/config"]).toBeUndefined();
    const rosterPaths = roster.map((r) => r.path);
    expect(rosterPaths).toContain(".git/");
    expect(rosterPaths).toContain("node_modules/");
    // our own plugin data dir is excluded (feedback loop)
    expect(byPath[".obsidian/plugins/littlewooly-sync/data.json"]).toBeUndefined();
    expect(roster.every((r) => r.reason.length > 0)).toBe(true);
  });

  test("records real sizes and is deterministically ordered", async () => {
    const adapter = new MockAdapter(
      new Map([
        ["b.md", "hello"],
        ["a.md", "hi"],
      ]),
    );
    const { entries } = await walkVault(adapter, opts);
    expect(entries.map((e) => e.path)).toEqual(["a.md", "b.md"]);
    expect(entries.find((e) => e.path === "b.md")!.size).toBe(5);
  });

  test("a stat failure is recorded on the roster, not skipped silently", async () => {
    const adapter = adapterWith(["ok.md", "ghost.md"]);
    const realStat = adapter.stat.bind(adapter);
    adapter.stat = async (p: string) => (p === "ghost.md" ? null : realStat(p));
    const { entries, roster } = await walkVault(adapter, opts);
    expect(entries.map((e) => e.path)).toContain("ok.md");
    expect(roster.find((r) => r.path === "ghost.md")).toBeTruthy();
  });

  test("a folder listing failure is recorded as unknown, never as absent", async () => {
    const adapter = adapterWith(["good/a.md", "broken/b.md"]);
    const realList = adapter.list.bind(adapter);
    adapter.list = async (dir: string) => {
      if (dir === "broken") throw new Error("io error");
      return realList(dir);
    };
    const { entries, roster } = await walkVault(adapter, opts);
    expect(entries.map((e) => e.path)).toEqual(["good/a.md"]);
    expect(roster.find((r) => r.path === "broken/")).toBeTruthy();
  });
});
