import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("What’s New worker barrel", () => {
  test("does not re-export the Node preview path", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain('from "./preview.js"');
  });
});
