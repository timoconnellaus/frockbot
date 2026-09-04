import { describe, expect, test } from "bun:test";

const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

describe("phone safe-area layout", () => {
  test("keeps the conversation header and thread below the status bar", () => {
    expect(styles).toContain(
      "height: calc(var(--frock-titlebar-height) + var(--frock-safe-top));",
    );
    expect(styles).toContain("padding-top: calc(var(--frock-safe-top) + 0px);");
    expect(styles).toContain(
      "top: calc(var(--frock-titlebar-height) + var(--frock-safe-top));",
    );
  });

  test("keeps drawers, Settings, and the composer clear of both bars", () => {
    expect(styles).toContain(
      "padding-bottom: calc(10px + var(--frock-safe-bottom));",
    );
    expect(styles).toContain(
      "padding-bottom: calc(16px + var(--frock-safe-bottom));",
    );
    expect(styles).toContain("bottom: calc(10px + var(--frock-safe-bottom));");
  });
});
