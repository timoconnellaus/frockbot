import { describe, expect, test } from "bun:test";
import { shellQuote } from "./shell.ts";

describe("Fly shell quoting", () => {
  test("quotes empty, whitespace, and shell metacharacters as one word", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a path; rm -rf /\n")).toBe("'a path; rm -rf /\n'");
  });

  test("uses one canonical spelling for an embedded single quote", () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
  });
});
