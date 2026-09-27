import { describe, test, expect, beforeEach } from "vitest";
import { log, logError, recentLog, resetLog } from "../../src/log";

describe("log", () => {
  beforeEach(() => resetLog());

  test("records entries oldest-first with level and message", () => {
    log("info", "one");
    log("warn", "two");
    const entries = recentLog();
    expect(entries.map((e) => e.msg)).toEqual(["one", "two"]);
    expect(entries.map((e) => e.level)).toEqual(["info", "warn"]);
  });

  test("keeps timestamps", () => {
    const before = Date.now();
    log("info", "hi");
    const after = Date.now();
    const [e] = recentLog();
    expect(e.ts).toBeGreaterThanOrEqual(before);
    expect(e.ts).toBeLessThanOrEqual(after);
  });

  test("caps the ring buffer at 500, evicting the oldest", () => {
    for (let i = 0; i < 520; i++) log("info", `entry ${i}`);
    const entries = recentLog();
    expect(entries).toHaveLength(500);
    expect(entries[0].msg).toBe("entry 20");
    expect(entries.at(-1)!.msg).toBe("entry 519");
  });

  test("logError captures message and stack as detail", () => {
    logError("sync", new Error("boom"));
    const [e] = recentLog();
    expect(e.level).toBe("error");
    expect(e.msg).toBe("sync failed: boom");
    expect(e.detail).toContain("Error: boom");
  });

  test("logError stringifies non-Error values", () => {
    logError("audit", "nope");
    const [e] = recentLog();
    expect(e.msg).toBe("audit failed: nope");
  });

  test("recentLog returns a copy (mutating it does not corrupt the buffer)", () => {
    log("info", "kept");
    recentLog().pop();
    expect(recentLog()).toHaveLength(1);
  });

  test("resetLog empties the buffer", () => {
    log("info", "gone");
    resetLog();
    expect(recentLog()).toEqual([]);
  });
});
