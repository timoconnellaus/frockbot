import { describe, expect, test } from "bun:test";

const stylesheet = await Bun.file(
  new URL("./src/client/theme.css", import.meta.url),
).text();
const generated = await Bun.file(
  new URL("./src/client/tokens.generated.css", import.meta.url),
).text();

/** The first `:root` declaration of a property, across both stylesheets. */
function declaration(name: string): string {
  for (const sheet of [stylesheet, generated]) {
    const match = sheet.match(new RegExp(`\\n  ${name}:\\s*([^;]+);`));
    if (match) return match[1].trim();
  }
  throw new Error(`Theme token ${name} is not declared`);
}

/** Resolves `var(--x)` chains down to a literal value. */
function resolve(name: string, depth = 0): string {
  if (depth > 8) throw new Error(`Theme token ${name} resolves too deeply`);
  const value = declaration(name);
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  return ref ? resolve(ref[1], depth + 1) : value;
}

type Rgb = [number, number, number];

/** `#rrggbb` or `rgb(r g b / a%)`, composited over `over` when translucent. */
function color(value: string, over?: Rgb): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return hex[1].match(/.{2}/g)!.map((c) => Number.parseInt(c, 16)) as Rgb;
  }
  const rgb = value.match(/^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(\d+)%)?\)$/i);
  if (!rgb) throw new Error(`Not a colour this test can read: ${value}`);
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as Rgb;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / 100;
  if (alpha === 1 || over === undefined) return [r, g, b];
  return [r, g, b].map((c, i) => c * alpha + over[i] * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b]
    .map((channel) => channel / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const brighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (brighter + 0.05) / (darker + 0.05);
}

const window = color(resolve("--frock-surface-window"));

describe("dark product theme on the Frock UI tokens", () => {
  test("declares one dark native-control theme and the FrockBot accent", () => {
    expect(stylesheet).toMatch(/color-scheme:\s*dark/);
    expect(resolve("--frock-action-primary")).toBe("#ec386b");

    for (const surface of [
      "--frock-surface-window",
      "--frock-surface",
      "--frock-surface-sidebar",
      "--frock-surface-raised",
      "--frock-surface-subtle",
    ]) {
      expect(luminance(color(resolve(surface)))).toBeLessThan(0.2);
    }
  });

  test("the aliases every plugin reads resolve to generated tokens", () => {
    for (const alias of [
      "--frock-text",
      "--frock-surface",
      "--frock-border",
      "--frock-text-base",
      "--frock-control-md",
      "--frock-radius-card",
    ]) {
      expect(declaration(alias)).toMatch(/^var\(--frock-ui-/);
    }
    expect(resolve("--frock-text-base")).toBe("13px");
    expect(resolve("--frock-text-md")).toBe("14px");
    expect(resolve("--frock-control-md")).toBe("32px");
  });

  test.each(["success", "warning", "danger"])(
    "%s status text has at least 4.5:1 contrast on its surface",
    (status) => {
      const text = color(
        resolve(
          status === "danger" ? "--frock-danger-text" : `--frock-${status}`,
        ),
      );
      const surface = color(resolve(`--frock-${status}-surface`), window);
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("the phone density is the token file's, under the shell's breakpoint", () => {
    const phone = generated.match(
      /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/,
    );
    expect(phone).not.toBeNull();
    expect(phone![1]).toMatch(/--frock-ui-size-control-md:\s*36px/);
    expect(phone![1]).toMatch(/--frock-ui-type-message-size:\s*15px/);
    expect(phone![1]).toMatch(/--frock-ui-type-input-size:\s*16px/);
  });

  test("prefers Capacitor's corrected Android safe-area insets", () => {
    expect(stylesheet).toMatch(
      /--frock-safe-top:\s*var\(\s*--safe-area-inset-top,\s*env\(safe-area-inset-top,\s*0px\)\s*\)/,
    );
    expect(stylesheet).toMatch(
      /--frock-safe-bottom:\s*var\(\s*--safe-area-inset-bottom,\s*env\(safe-area-inset-bottom,\s*0px\)\s*\)/,
    );
  });
});
