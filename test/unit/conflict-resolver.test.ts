import { describe, test, expect } from "vitest";
import { conflictCopyName, mergeJson3 } from "../../src/engine/conflict-resolver";

describe("conflictCopyName", () => {
  test("preserves the extension and names the source device", () => {
    const name = conflictCopyName("Notes/todo.md", "mobile", 1718409600000);
    expect(name.startsWith("Notes/todo (conflict copy from mobile ")).toBe(true);
    expect(name.endsWith(".md")).toBe(true);
  });

  test("handles extensionless paths", () => {
    const name = conflictCopyName("LICENSE", "desktop", 0);
    expect(name.startsWith("LICENSE (conflict copy from desktop ")).toBe(true);
  });
});

describe("mergeJson3", () => {
  test("merges non-conflicting edits from both sides", () => {
    const base = { a: 1, b: 2 };
    const mine = { a: 1, b: 2, c: 3 }; // added c
    const theirs = { a: 9, b: 2 }; // changed a
    expect(mergeJson3(base, mine, theirs)).toEqual({ a: 9, b: 2, c: 3 });
  });

  test("returns null when both sides change the same key differently", () => {
    const base = { a: 1 };
    const mine = { a: 2 };
    const theirs = { a: 3 };
    expect(mergeJson3(base, mine, theirs)).toBeNull();
  });
});
