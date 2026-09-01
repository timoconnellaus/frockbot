import { describe, expect, test } from "bun:test";

const stylesheet = await Bun.file(
  new URL("./src/client/theme.css", import.meta.url),
).text();

function token(name: string): string {
  const match = stylesheet.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`Theme token ${name} is missing a hex value`);
  return match[1].toLowerCase();
}

function luminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const brighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (brighter + 0.05) / (darker + 0.05);
}

describe("dark product theme", () => {
  test("declares one dark native-control theme and the FrockBot accent", () => {
    expect(stylesheet).toMatch(/color-scheme:\s*dark/);
    expect(token("--frock-action-primary")).toBe("#ec386b");

    for (const surface of [
      "--frock-surface-window",
      "--frock-surface",
      "--frock-surface-sidebar",
      "--frock-surface-raised",
      "--frock-surface-subtle",
    ]) {
      expect(luminance(token(surface))).toBeLessThan(0.2);
    }
  });

  test.each(["success", "warning", "danger"])(
    "%s status text has at least 4.5:1 contrast on its surface",
    (status) => {
      const text = token(
        status === "danger" ? "--frock-danger-text" : `--frock-${status}`,
      );
      const surface = token(`--frock-${status}-surface`);
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
