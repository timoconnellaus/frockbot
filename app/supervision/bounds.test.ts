import { expect, test } from "bun:test";
import { clipEndsV1 } from "./bounds.js";

test("a long text keeps its start and its end", () => {
  const text = `${"hand-off line. ".repeat(80)}Can you remember that my wife is Becky`;
  const clipped = clipEndsV1(text, 600);
  expect(clipped.length).toBe(601);
  expect(clipped.startsWith("hand-off line.")).toBe(true);
  expect(clipped.endsWith("Can you remember that my wife is Becky")).toBe(true);
  expect(clipEndsV1("short", 600)).toBe("short");
});
